/**
 * store-sqlite.mjs — durable, drop-in replacement for the in-memory StreamHub.
 *
 * Same method surface (`createMessage`, `append`, `resumeFrom`, `describe`,
 * `findByRequestId`, `markError`, `appendTerminalIfStranded`, `has`, `size`) so
 * the server can swap it in without changing a line of business logic.
 *
 * Two schema decisions carry the whole design:
 *
 *  1. `PRIMARY KEY (message_id, seq)` on the frame table. This is not an index
 *     for speed — it is the thing that makes monotonic `seq` hold when two
 *     writers race. The in-memory hub had to *document* this requirement; here
 *     the database enforces it.
 *  2. A **partial** unique index on `(channel, request_id) WHERE request_id <> ''`.
 *     That is what makes `request_id` idempotency durable across restarts. A
 *     plain UNIQUE would be a bug: every message created without a request_id
 *     carries `''` and would collide with the next one.
 *
 * `node:sqlite` is built into Node 24, so this adds no dependency.
 *
 * @module store-sqlite
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import { CHAT_EVENT, TERMINAL_EVENTS, chatFrame } from './frames.mjs';

/** Same typed-error shape as the in-memory hub, so callers cannot tell them apart. */
export class StreamHubError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'StreamHubError';
    this.code = code;
    this.status = status;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  message_id       TEXT PRIMARY KEY,
  channel          TEXT NOT NULL,
  conversation_id  TEXT NOT NULL DEFAULT '',
  archive_id       TEXT NOT NULL DEFAULT '',
  request_id       TEXT NOT NULL DEFAULT '',
  principal_id     TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'open',
  retryable        INTEGER NOT NULL DEFAULT 0,
  abort_reason     TEXT,
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_request
  ON messages (channel, request_id) WHERE request_id <> '';
CREATE TABLE IF NOT EXISTS frames (
  message_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  frame_json  TEXT NOT NULL,
  PRIMARY KEY (message_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_frames_message ON frames (message_id, seq);
`;

export class SqliteStreamHub {
  /** @param {string} [path] `:memory:` for tests, a file for durability. */
  constructor(path = ':memory:') {
    this.path = path;
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.#seqCounter = 0;
  }

  #seqCounter;

  // -------------------------------------------------------------------------
  // messages
  // -------------------------------------------------------------------------

  /**
   * @param {{channel: string, conversationId?: string, archiveId?: string, requestId?: string, principalId?: string, messageId?: string}} init
   */
  createMessage({ channel, conversationId = '', archiveId = '', requestId = '', principalId = '', messageId }) {
    if (!channel) throw new StreamHubError('CHANNEL_REQUIRED', 'channel is required');
    const id = messageId ?? this.#newId('msg');
    const row = {
      message_id: id,
      channel,
      conversation_id: conversationId,
      archive_id: archiveId,
      request_id: requestId,
      principal_id: principalId,
      created_at: Date.now(),
    };
    try {
      this.db.prepare(`INSERT INTO messages (message_id, channel, conversation_id, archive_id, request_id, principal_id, created_at)
                       VALUES (:message_id, :channel, :conversation_id, :archive_id, :request_id, :principal_id, :created_at)`).run(row);
    } catch (err) {
      // Two causes, both worth distinguishing for the caller.
      if (/UNIQUE/i.test(err.message) && /messages\.message_id/.test(err.message)) {
        throw new StreamHubError('MESSAGE_ID_TAKEN', `message ${id} already exists`, 409);
      }
      if (/UNIQUE/i.test(err.message)) {
        throw new StreamHubError('REQUEST_ID_TAKEN', `request_id ${requestId} already exists on channel ${channel}`, 409);
      }
      throw err;
    }
    return this.describe(id);
  }

  /** Durable idempotency lookup: survives a restart, unlike a Map. */
  findByRequestId(channel, requestId) {
    if (!requestId) return null;
    const row = this.db.prepare('SELECT message_id FROM messages WHERE channel = ? AND request_id = ?').get(channel, requestId);
    return row ? this.describe(row.message_id) : null;
  }

  describe(messageId) {
    const m = this.#require(messageId);
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM frames WHERE message_id = ?').get(messageId);
    return {
      messageId: m.message_id,
      channel: m.channel,
      conversationId: m.conversation_id,
      archiveId: m.archive_id,
      requestId: m.request_id,
      principalId: m.principal_id,
      status: m.status,
      retryable: m.retryable === 1,
      lastSeq: n,
      state: { frameCount: n },
      createdAt: m.created_at,
      completedAt: m.completed_at,
      abortReason: m.abort_reason ?? undefined,
    };
  }

  has(messageId) {
    return this.db.prepare('SELECT 1 AS x FROM messages WHERE message_id = ?').get(messageId) !== undefined;
  }

  get size() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  }

  // -------------------------------------------------------------------------
  // frames
  // -------------------------------------------------------------------------

  /**
   * Appends one frame. The sequence number is derived inside the same statement
   * transaction as the insert, and the primary key rejects a collision — so a
   * double-write can fail loudly but can never create two frames with one seq.
   */
  append(messageId, { event, msg = {}, retryable = false }) {
    const m = this.#require(messageId);
    if (m.status !== 'open') {
      throw new StreamHubError('MESSAGE_CLOSED', `cannot append ${event}: message is ${m.status}`, 409);
    }
    return this.#insert(messageId, { event, msg, retryable });
  }

  /**
   * Gives a message that died without a terminal frame exactly one ending, so a
   * late reconnect replays an ending instead of polling until a deadline.
   *
   * The check is for a terminal FRAME, not for `status`: a transport abort marks
   * the message `error` without ever writing one, and that is precisely the case
   * this method exists for. That is also why it bypasses `append`'s open-guard.
   *
   * @returns {object|null} the appended frame, or null when an ending exists.
   */
  appendTerminalIfStranded(messageId, { event, msg = {}, retryable = false }) {
    this.#require(messageId);
    const last = this.db.prepare('SELECT frame_json FROM frames WHERE message_id = ? ORDER BY seq DESC LIMIT 1').get(messageId);
    if (last && TERMINAL_EVENTS.includes(JSON.parse(last.frame_json)?.msg?.event)) return null;
    return this.#insert(messageId, { event, msg, retryable });
  }

  /** The one place that assigns a sequence number and writes a frame. */
  #insert(messageId, { event, msg = {}, retryable = false }) {
    const { s } = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM frames WHERE message_id = ?').get(messageId);
    const seq = s + 1;
    const frame = chatFrame({ messageId, seq, event, msg, retryable });
    try {
      this.db.prepare('INSERT INTO frames (message_id, seq, frame_json) VALUES (?, ?, ?)')
        .run(messageId, seq, JSON.stringify(frame));
    } catch (err) {
      if (/UNIQUE|PRIMARY/i.test(err.message)) {
        throw new StreamHubError('SEQ_CONFLICT', `seq ${seq} already exists for ${messageId}`, 409);
      }
      throw err;
    }
    const terminal = TERMINAL_EVENTS.includes(event);
    this.db.prepare('UPDATE messages SET retryable = ?, status = ?, completed_at = ? WHERE message_id = ?')
      .run(
        retryable ? 1 : 0,
        terminal ? (event === CHAT_EVENT.END ? 'complete' : 'error') : 'open',
        terminal ? Date.now() : 0,
        messageId,
      );
    return frame;
  }

  /**
   * Resumes a message: frames with `seq > fromSeq`, in order, no gaps, no
   * duplicates. Ordering comes from the primary key, so it holds even after a
   * process restart.
   */
  resumeFrom(messageId, fromSeq = 0) {
    const m = this.#require(messageId);
    if (!Number.isInteger(fromSeq) || fromSeq < 0) {
      throw new StreamHubError('INVALID_FROM_SEQ', 'from_seq must be a non-negative integer');
    }
    const rows = this.db.prepare('SELECT frame_json FROM frames WHERE message_id = ? AND seq > ? ORDER BY seq ASC').all(messageId, fromSeq);
    const frames = rows.map((r) => JSON.parse(r.frame_json));
    const { n: lastSeq } = this.db.prepare('SELECT COUNT(*) AS n FROM frames WHERE message_id = ?').get(messageId);
    const terminal = frames.length > 0 && TERMINAL_EVENTS.includes(frames.at(-1)?.msg?.event) ? frames.at(-1) : null;
    return { messageId, frames, status: m.status, terminal, lastSeq };
  }

  frames(messageId) {
    return this.db.prepare('SELECT frame_json FROM frames WHERE message_id = ? ORDER BY seq ASC').all(messageId)
      .map((r) => JSON.parse(r.frame_json));
  }

  /** A transport-level abort: recorded, but no frame is invented for the client. */
  markError(messageId, reason) {
    const m = this.#require(messageId);
    if (m.status === 'open') {
      this.db.prepare('UPDATE messages SET status = ?, completed_at = ?, abort_reason = ? WHERE message_id = ?')
        .run('error', Date.now(), reason ?? 'unknown', messageId);
    }
    return this.describe(messageId);
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  #require(messageId) {
    const m = this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
    if (!m) throw new StreamHubError('MESSAGE_NOT_FOUND', `unknown message ${messageId}`, 404);
    return m;
  }

  #newId(prefix) {
    // Collision-safe across processes AND restarts. A timestamp+counter scheme
    // looks unique but is not: two instances starting in the same millisecond
    // both begin at counter 1 and produce the same id — which the primary key
    // then rejects, turning a generation bug into an outage.
    return `${prefix}_${randomUUID()}`;
  }
}

export default SqliteStreamHub;
