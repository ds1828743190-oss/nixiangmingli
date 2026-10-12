/**
 * stream-hub.mjs — in-memory session/message store that makes a chat stream
 * resumable.
 *
 * The whole point of this module is one invariant:
 *
 *     For a message with frames f1..fn, resumeFrom(id, N) returns exactly
 *     the frames with seq > N, in order, no gaps, no duplicates.
 *
 * Two design choices follow from it:
 *
 *  1. `seq` is assigned by the store, never by the producer. If a producer could
 *     pick its own numbering, a retried write could reuse or skip a number and
 *     a resuming client would either lose text or render it twice.
 *  2. Frames are kept verbatim after the fact. A resume is a *replay of stored
 *     bytes*, not a regeneration. Regenerating would produce different prose —
 *     the user would watch their answer rewrite itself mid-sentence.
 *
 * The store is in-memory and therefore single-process. A real deployment puts
 * the same shape behind Redis/Postgres with an append-only table keyed on
 * (message_id, seq) and a unique constraint on that pair — the constraint is
 * what actually enforces invariant (1) under concurrency.
 *
 * Billing note (why messageId matters): quota is charged once per *message*, at
 * creation. A reconnect, a resume, or a retry of the transport is not a new
 * message and must not be a second charge.
 *
 * @module stream-hub
 */

import { CHAT_EVENT, chatFrame } from './frames.mjs';

/** Thrown for caller errors (unknown message, bad cursor) — not server faults. */
export class StreamHubError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'StreamHubError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @typedef {object} StoredMessage
 * @property {string} messageId
 * @property {string} channel
 * @property {string} conversationId
 * @property {string} archiveId
 * @property {string} requestId
 * @property {string} principalId     Owner. A messageId is not a cross-account credential.
 * @property {object[]} frames        Committed frames, index i holds seq i+1.
 * @property {object} state           Counters only; never used to reconstruct text.
 * @property {'open'|'complete'|'error'} status
 * @property {boolean} retryable      Last frame's retryability, for the client gate.
 * @property {number} createdAt
 * @property {number} completedAt
 */

export class StreamHub {
  /** @type {Map<string, StoredMessage>} */
  #messages = new Map();
  #seqCounter = 0;

  /**
   * Creates the message row *before* the first frame exists.
   *
   * Creating it up front, in its own step, is what lets a dropped connection
   * still name a resumable resource: the client got the messageId in frame 1,
   * so even if the socket dies at frame 2 it knows exactly what to re-ask for.
   *
   * @param {{channel: string, conversationId?: string, archiveId?: string, requestId?: string, principalId?: string, messageId?: string}} init
   * @returns {StoredMessage}
   */
  createMessage({ channel, conversationId = '', archiveId = '', requestId = '', principalId = '', messageId }) {
    if (!channel) throw new StreamHubError('CHANNEL_REQUIRED', 'channel is required');
    const id = messageId ?? this.#newId('msg');
    if (this.#messages.has(id)) {
      throw new StreamHubError('MESSAGE_ID_TAKEN', `message ${id} already exists`, 409);
    }
    /** @type {StoredMessage} */
    const message = {
      messageId: id,
      channel,
      conversationId,
      archiveId,
      requestId,
      principalId,
      frames: [],
      state: { frameCount: 0, contentChunks: 0 },
      status: 'open',
      retryable: false,
      createdAt: Date.now(),
      completedAt: 0,
    };
    this.#messages.set(id, message);
    return message;
  }

  /**
   * Finds the message already created for one (channel, requestId) pair.
   *
   * This is what makes `request_id` idempotent: a client that retries a request
   * it is not sure landed must land on the SAME message (and therefore the same
   * stored answer, and the same single charge), not on a second, differently
   * worded generation. See PROTOCOL.md §5.
   *
   * @param {string} channel
   * @param {string} requestId
   * @returns {StoredMessage|null}
   */
  findByRequestId(channel, requestId) {
    if (!requestId) return null;
    for (const m of this.#messages.values()) {
      if (m.channel === channel && m.requestId === requestId) return m;
    }
    return null;
  }

  /**
   * Appends one frame and returns it with its assigned `seq`.
   *
   * @param {string} messageId
   * @param {{event: string, msg?: object, retryable?: boolean}} spec
   * @returns {object} the stored frame, seq included
   */
  append(messageId, { event, msg = {}, retryable = false }) {
    const message = this.#require(messageId);
    if (message.status !== 'open') {
      // Appending after a terminal frame would create a hole in every client
      // that already saw `end`. Fail loudly instead.
      throw new StreamHubError(
        'MESSAGE_CLOSED',
        `cannot append ${event}: message is ${message.status}`,
        409,
      );
    }
    const seq = message.frames.length + 1;
    const frame = chatFrame({ messageId, seq, event, msg, retryable });
    message.frames.push(frame);
    message.state.frameCount = seq;
    if (event === CHAT_EVENT.MESSAGE) message.state.contentChunks += 1;
    message.retryable = retryable;
    if (event === CHAT_EVENT.END || event === CHAT_EVENT.ERROR) {
      message.status = event === CHAT_EVENT.END ? 'complete' : 'error';
      message.completedAt = Date.now();
    }
    return frame;
  }

  /**
   * Resumes a message.
   *
   * @param {string} messageId
   * @param {number} fromSeq Return only frames with seq strictly greater than this.
   * @returns {{frames: object[], status: 'open'|'complete'|'error', terminal: object|null, messageId: string, lastSeq: number}}
   *
   * Semantics a caller can rely on:
   *  - `from_seq=N` is exclusive. The client passes the last seq it *rendered*,
   *    so exclusivity is what guarantees "no duplicate".
   *  - Frames are contiguous, so "no gap" holds for any N the client could
   *    legitimately hold.
   *  - If the message already completed, the replay still returns the frames
   *    after N, ending with the terminal frame — a late reconnect gets the tail
   *    it missed and then a clean end, rather than an open socket.
   *  - If N is beyond `lastSeq`, the result is empty. That is not an error: it
   *    means the client is simply ahead, and it should wait for new appends.
   */
  resumeFrom(messageId, fromSeq = 0) {
    const message = this.#require(messageId);
    if (!Number.isInteger(fromSeq) || fromSeq < 0) {
      throw new StreamHubError('INVALID_FROM_SEQ', 'from_seq must be a non-negative integer');
    }
    const frames = message.frames.filter((f) => f.seq > fromSeq);
    const lastSeq = message.frames.length;
    const terminal = message.frames.length > 0 && this.#isTerminal(message.frames.at(-1))
      ? message.frames.at(-1)
      : null;
    return { messageId, frames, status: message.status, terminal, lastSeq };
  }

  /**
   * Metadata without frames — used to decide whether a reconnect should attach
   * at all (a completed message is a no-op resume).
   * @param {string} messageId
   */
  describe(messageId) {
    const m = this.#require(messageId);
    return {
      messageId: m.messageId,
      channel: m.channel,
      conversationId: m.conversationId,
      archiveId: m.archiveId,
      requestId: m.requestId,
      principalId: m.principalId,
      status: m.status,
      retryable: m.retryable,
      lastSeq: m.frames.length,
      state: { ...m.state },
      createdAt: m.createdAt,
      completedAt: m.completedAt,
    };
  }

  /** All frames of a message, for tests and replay tooling. */
  frames(messageId) {
    return [...this.#require(messageId).frames];
  }

  /** Marks a message failed without appending an error frame (transport-level abort). */
  markError(messageId, reason) {
    const m = this.#require(messageId);
    if (m.status === 'open') {
      m.status = 'error';
      m.completedAt = Date.now();
      m.state.abortReason = reason ?? 'unknown';
    }
    return this.describe(messageId);
  }

  /**
   * Appends a terminal frame to a message that was closed by a transport abort.
   *
   * Why this exists: a client that disconnects mid-stream is marked `error`
   * without a terminal frame (it never saw one). A later reconnect would then
   * poll a message that can never grow and hang until its own deadline. Writing
   * the terminal frame makes the resumed stream well-formed AND idempotent —
   * every subsequent resume replays it instead of manufacturing a new one.
   *
   * @param {string} messageId
   * @param {object} spec  Same shape as `append`.
   * @returns {object|null} the terminal frame a resumer should send, or null if none was needed.
   */
  appendTerminalIfStranded(messageId, spec) {
    const m = this.#require(messageId);
    if (m.frames.length > 0 && this.#isTerminal(m.frames.at(-1))) return null;
    if (m.status === 'complete') return null;
    // Reopen just long enough to write the missing terminal frame; the message
    // ends in a terminal state again either way.
    m.status = 'open';
    return this.append(messageId, spec);
  }

  has(messageId) {
    return this.#messages.has(messageId);
  }

  get size() {
    return this.#messages.size;
  }

  #require(messageId) {
    const m = this.#messages.get(messageId);
    if (!m) throw new StreamHubError('MESSAGE_NOT_FOUND', `unknown message ${messageId}`, 404);
    return m;
  }

  #isTerminal(frame) {
    return frame?.msg?.event === CHAT_EVENT.END || frame?.msg?.event === CHAT_EVENT.ERROR;
  }

  #newId(prefix) {
    this.#seqCounter += 1;
    // Deterministic, dependency-free id. Real deployments use a UUID and let the
    // database own uniqueness; here the counter is enough to be collision-free.
    return `${prefix}_${Date.now().toString(36)}_${this.#seqCounter.toString(36)}`;
  }
}

export default StreamHub;
