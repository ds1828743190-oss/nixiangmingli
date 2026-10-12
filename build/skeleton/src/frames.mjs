/**
 * frames.mjs — wire formats for the two stream contracts.
 *
 * Two transports, two encodings, deliberately kept in one place so the
 * asymmetry is visible:
 *
 *   A) Agent stream  — NDJSON: one JSON object per line, `\n`-terminated,
 *      `content-type: text/plain`. The server pushes *semantic* frames
 *      (reasoning / tool / phase / content) as first-class message types, so
 *      the UI never has to scrape prose to know what the model is doing.
 *
 *   B) Chat stream   — SSE: `data: <json>\n\n`, `content-type: text/event-stream`.
 *      Every frame carries `messageId` + a monotonic `seq`. The seq is not
 *      decoration: it is the resume cursor (see stream-hub.mjs).
 *
 * Both parsers are written to be fed arbitrary chunk boundaries, because a
 * network read almost never lands on a frame boundary. Anything incomplete is
 * buffered, never guessed at.
 *
 * @module frames
 */

/** Agent NDJSON frame types (route A). */
export const AGENT_FRAME = Object.freeze({
  CONVERSATION_ID: 'conversation_id',
  REASONING: 'reasoning',
  PHASE_CHANGE: 'phase_change',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  CONTENT: 'content',
  KEEP_ALIVE: 'keep-alive',
  ERROR: 'error',
});

/** Chat SSE event kinds carried *inside* the frame JSON (route B). */
export const CHAT_EVENT = Object.freeze({
  START: 'start',
  MESSAGE: 'message',
  ACTION: 'action',
  END: 'end',
  ERROR: 'error',
});

/** The terminal kinds: once one is stored, the message can never gain frames. */
export const TERMINAL_EVENTS = Object.freeze([CHAT_EVENT.END, CHAT_EVENT.ERROR]);

/**
 * SSE terminator emitted after the terminal frame. The contract only requires
 * "returns the terminal frame then ends"; the explicit sentinel plus
 * `res.end()` means a client that reconnects cannot loop forever waiting for
 * frames that will never come.
 */
export const SSE_DONE = '[DONE]';

// ---------------------------------------------------------------------------
// A) Agent NDJSON frame constructors
// ---------------------------------------------------------------------------

export const agentFrames = {
  /** Binds the stream to a conversation; the client stores the id for the next turn. */
  conversationId: (conversationId) => ({ type: AGENT_FRAME.CONVERSATION_ID, conversationId }),
  /** Chain-of-thought. Rendering it is a product decision; the protocol only carries it. */
  reasoning: (content) => ({ type: AGENT_FRAME.REASONING, content }),
  /** Empty by design: signals "reasoning is done, prose starts". No payload to version. */
  phaseChange: () => ({ type: AGENT_FRAME.PHASE_CHANGE }),
  /** `arguments` is the raw model-proposed object; it is NOT yet validated. */
  toolCall: (name, args) => ({ type: AGENT_FRAME.TOOL_CALL, toolCall: { name, arguments: args } }),
  /**
   * `index` is the correlation key back to the toolCall at the same index.
   * Tool calls may interleave, so position in the stream is not enough.
   */
  toolResult: (index, result) => ({ type: AGENT_FRAME.TOOL_RESULT, index, result }),
  content: (content) => ({ type: AGENT_FRAME.CONTENT, content }),
  /** Liveness only. Must be ignorable by any client that does not understand it. */
  keepAlive: () => ({ type: AGENT_FRAME.KEEP_ALIVE }),
  error: (message, extra = {}) => ({ type: AGENT_FRAME.ERROR, message, ...extra }),
};

// ---------------------------------------------------------------------------
// B) Chat SSE frame constructors
// ---------------------------------------------------------------------------

/**
 * Builds one chat frame. `seq` is assigned by the hub, not by the caller, so the
 * numbering can never fork. `retryable` tells the client whether a *reconnect*
 * (not a regenerate) is the correct recovery: a 500-style drop is retryable, a
 * quota rejection is not — retrying it would just burn the user's patience.
 *
 * @param {object} fields
 * @param {string} fields.messageId
 * @param {number} fields.seq          1-based, strictly increasing per messageId.
 * @param {'start'|'message'|'action'|'end'|'error'} fields.event
 * @param {object} [fields.msg]        Event payload.
 * @param {boolean} [fields.retryable]
 * @returns {object}
 */
export function chatFrame({ messageId, seq, event, msg = {}, retryable = false }) {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new RangeError(`chatFrame: seq must be an integer >= 1, got ${String(seq)}`);
  }
  return { messageId, seq, retryable, msg: { event, ...msg } };
}

/** The event kind of a chat frame, read back out of `msg`. */
export function frameEvent(frame) {
  return frame?.msg?.event ?? null;
}

/** True when this frame closes the message (no further seq can ever exist). */
export function isTerminalFrame(frame) {
  return TERMINAL_EVENTS.includes(frameEvent(frame));
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

/**
 * Encodes one frame as an NDJSON line. The trailing `\n` is part of the frame:
 * the client splits on newline, so a frame without it would sit in the buffer
 * forever.
 */
export function encodeNdjson(frame) {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Encodes one frame as an SSE event block. `data:` is followed by a space then
 * compact JSON; the blank line is the frame terminator. JSON is single-line by
 * construction, so multi-line `data:` continuation is never needed.
 */
export function encodeSse(frame) {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/** Encodes the SSE terminator block. */
export function encodeSseDone() {
  return `data: ${SSE_DONE}\n\n`;
}

// ---------------------------------------------------------------------------
// Parsers — all of them tolerate partial chunks
// ---------------------------------------------------------------------------

/**
 * Incremental NDJSON parser.
 *
 * Feed it whatever the socket handed you; it returns only frames that were
 * fully terminated by a newline and retains the remainder. Malformed complete
 * lines are reported through `onError` instead of being silently dropped —
 * silent drops are how a client ends up hanging on a stream that is actually
 * broken.
 */
export class NdjsonParser {
  #buffer = '';

  /** @param {{onError?: (line: string, err: Error) => void}} [opts] */
  constructor({ onError } = {}) {
    this.onError = onError ?? (() => {});
  }

  /**
   * @param {string} chunk
   * @returns {object[]} frames completed by this chunk (possibly none)
   */
  push(chunk) {
    this.#buffer += chunk;
    const frames = [];
    let nl;
    while ((nl = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + 1);
      const trimmed = line.trim();
      if (trimmed === '') continue; // blank keep-alive padding is legal noise
      try {
        frames.push(JSON.parse(trimmed));
      } catch (err) {
        this.onError(line, /** @type {Error} */ (err));
      }
    }
    return frames;
  }

  /** Frame bytes received but not yet terminated. Non-empty means "more coming". */
  get pending() {
    return this.#buffer;
  }
}

/**
 * Incremental SSE parser.
 *
 * Splits on the blank line, then takes the `data:` line(s) inside. Per the
 * observed client behaviour the capture regex is `/^data:\s*(.+)$/m` — a frame
 * with no `data:` line is skipped, and so is the `[DONE]` sentinel, which is a
 * transport marker rather than a frame.
 */
export class SseParser {
  #buffer = '';
  #done = false;

  /** @param {{onError?: (frame: string, err: Error) => void}} [opts] */
  constructor({ onError } = {}) {
    this.onError = onError ?? (() => {});
  }

  /** True once the `[DONE]` sentinel has been seen. */
  get done() {
    return this.#done;
  }

  /** Frame bytes received but not yet terminated by a blank line. */
  get pending() {
    return this.#buffer;
  }

  /**
   * @param {string} chunk
   * @returns {object[]} frames completed by this chunk
   */
  push(chunk) {
    this.#buffer += chunk;
    const frames = [];
    let sep;
    while ((sep = this.#buffer.indexOf('\n\n')) !== -1) {
      const raw = this.#buffer.slice(0, sep);
      this.#buffer = this.#buffer.slice(sep + 2);
      const payload = extractSseData(raw);
      if (payload === null) continue;
      if (payload === SSE_DONE) {
        this.#done = true;
        continue;
      }
      try {
        frames.push(JSON.parse(payload));
      } catch (err) {
        this.onError(raw, /** @type {Error} */ (err));
      }
    }
    return frames;
  }
}

/**
 * Pulls the payload out of one raw SSE block.
 * @param {string} raw
 * @returns {string|null} null when the block carries no `data:` line.
 */
export function extractSseData(raw) {
  const lines = raw.split('\n');
  const parts = [];
  for (const line of lines) {
    // `data:` with no space must still parse; the spec allows both.
    const m = /^data:\s?(.*)$/.exec(line);
    if (m) parts.push(m[1]);
  }
  if (parts.length === 0) return null;
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Client-side resilience policy (declared here so client and test share it)
// ---------------------------------------------------------------------------

/**
 * Route A reader semantics. The inactivity timer is what actually saves a
 * stalled NDJSON stream: a server that dies mid-response leaves the socket open
 * on some proxies, so "no bytes for 30s" is a stronger failure signal than
 * "socket closed".
 */
export const AGENT_READER_POLICY = Object.freeze({
  inactivityTimeoutMs: 30_000,
  inactivityPollMs: 5_000,
  maxRetries: 3,
  retryBackoffMs: 2_000,
});

/** Route B reconnect policy, observed verbatim from the client. */
export const CHAT_RETRY_POLICY = Object.freeze({
  maxRetries: 5,
  baseDelayMs: 1_000,
  maxDurationMs: 120_000,
});

/**
 * Exponential backoff with a hard wall-clock cap.
 *
 * The cap is the important half: an unbounded exponential retry loop turns a
 * 2-minute outage into a background tab that hammers the API for an hour.
 *
 * @param {number} attempt           0-based retry attempt.
 * @param {number} elapsedMs         Time since the first attempt started.
 * @param {{maxRetries:number, baseDelayMs:number, maxDurationMs:number}} [policy]
 * @returns {{retry: boolean, delayMs: number, reason?: string}}
 */
export function nextRetry(attempt, elapsedMs, policy = CHAT_RETRY_POLICY) {
  if (attempt >= policy.maxRetries) {
    return { retry: false, delayMs: 0, reason: 'max_retries' };
  }
  const delayMs = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDurationMs);
  if (elapsedMs + delayMs > policy.maxDurationMs) {
    return { retry: false, delayMs: 0, reason: 'max_duration' };
  }
  return { retry: true, delayMs };
}
