/**
 * store-sqlite.test.mjs — durability and the constraints that make the stream
 * protocol's promises survive a restart.
 *
 * The in-memory hub could only *document* two requirements: monotonic `seq`
 * under concurrency, and a durable `(principal, request_id)` idempotency key.
 * These tests check that the database actually enforces them.
 *
 * @module test/store-sqlite
 */

import { test } from 'node:test';
import { tokenFor, TEST_SECRET, bearer } from './helpers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { SqliteStreamHub, StreamHubError } from '../src/store-sqlite.mjs';
import { CHAT_EVENT } from '../src/frames.mjs';

/** A throwaway database path. */
function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shensha-store-'));
  return path.join(dir, 'streams.db');
}

test('frames survive closing and reopening the store', () => {
  const dbPath = tmpDb();
  const first = new SqliteStreamHub(dbPath);
  const msg = first.createMessage({ channel: 'zhouyi-bagua', conversationId: 'c1', requestId: 'r1', principalId: 'user:1' });
  first.append(msg.messageId, { event: CHAT_EVENT.START, msg: {} });
  first.append(msg.messageId, { event: CHAT_EVENT.MESSAGE, msg: { content: 'partial' } });
  first.close();

  // A brand-new process would see exactly this: prior frames, prior status.
  const second = new SqliteStreamHub(dbPath);
  const resumed = second.resumeFrom(msg.messageId, 1);
  assert.equal(resumed.frames.length, 1);
  assert.equal(resumed.frames[0].seq, 2);
  assert.equal(resumed.frames[0].msg.content, 'partial');
  assert.equal(second.describe(msg.messageId).requestId, 'r1');
  second.close();
});

test('a duplicate (message_id, seq) is rejected by the primary key', () => {
  const hub = new SqliteStreamHub();
  const msg = hub.createMessage({ channel: 'demo' });
  hub.append(msg.messageId, { event: CHAT_EVENT.START, msg: {} });
  // The constraint is the guarantee, so assert it directly rather than trusting
  // the MAX(seq)+1 derivation to be the only writer.
  assert.throws(
    () => hub.db.prepare('INSERT INTO frames (message_id, seq, frame_json) VALUES (?, ?, ?)').run(msg.messageId, 1, '{}'),
    /UNIQUE|PRIMARY/i,
  );
});

test('request_id idempotency is durable: a restart finds the same message', () => {
  const dbPath = tmpDb();
  const first = new SqliteStreamHub(dbPath);
  const msg = first.createMessage({ channel: 'demo', requestId: 'req-abc', principalId: 'user:1' });
  first.close();

  const second = new SqliteStreamHub(dbPath);
  const found = second.findByRequestId('demo', 'req-abc');
  assert.equal(found.messageId, msg.messageId);
  // And a *different* request_id still creates a fresh message.
  const other = second.createMessage({ channel: 'demo', requestId: 'req-def' });
  assert.notEqual(other.messageId, msg.messageId);
  second.close();
});

test('a repeated request_id on the same channel is refused', () => {
  const hub = new SqliteStreamHub();
  hub.createMessage({ channel: 'demo', requestId: 'req-1' });
  assert.throws(() => hub.createMessage({ channel: 'demo', requestId: 'req-1' }), (err) => err.code === 'REQUEST_ID_TAKEN');
});

test('empty request_ids do NOT collide (the partial-index trap)', () => {
  const hub = new SqliteStreamHub();
  // A naive UNIQUE(channel, request_id) would make the second of these fail,
  // which would break every request that has no idempotency key at all.
  const a = hub.createMessage({ channel: 'demo' });
  const b = hub.createMessage({ channel: 'demo' });
  assert.notEqual(a.messageId, b.messageId);
  assert.equal(hub.size, 2);
});

test('resume is gapless and duplicate-free, and beyond-the-end is empty', () => {
  const hub = new SqliteStreamHub();
  const msg = hub.createMessage({ channel: 'demo', principalId: 'user:1' });
  hub.append(msg.messageId, { event: CHAT_EVENT.START, msg: {} });
  for (let i = 0; i < 5; i += 1) hub.append(msg.messageId, { event: CHAT_EVENT.MESSAGE, msg: { content: `c${i}` } });
  hub.append(msg.messageId, { event: CHAT_EVENT.END, msg: { content: 'done' } });

  const tail = hub.resumeFrom(msg.messageId, 2);
  assert.deepEqual(tail.frames.map((f) => f.seq), [3, 4, 5, 6, 7]);
  assert.equal(tail.terminal?.msg?.event, CHAT_EVENT.END);
  assert.equal(hub.resumeFrom(msg.messageId, 99).frames.length, 0);
  assert.equal(hub.resumeFrom(msg.messageId, 0).frames.length, 7);
});

test('terminal state is enforced and stranded messages get exactly one ending', () => {
  const hub = new SqliteStreamHub();
  const msg = hub.createMessage({ channel: 'demo' });
  hub.append(msg.messageId, { event: CHAT_EVENT.START, msg: {} });
  hub.markError(msg.messageId, 'client_disconnected');
  assert.equal(hub.describe(msg.messageId).status, 'error');
  // A stranded (errored, no terminal frame) message can be closed exactly once.
  const first = hub.appendTerminalIfStranded(msg.messageId, { event: CHAT_EVENT.ERROR, msg: { code: 'UPSTREAM_ABORTED' }, retryable: true });
  const second = hub.appendTerminalIfStranded(msg.messageId, { event: CHAT_EVENT.ERROR, msg: { code: 'UPSTREAM_ABORTED' }, retryable: true });
  assert.equal(second, null, 'a second ending must not be appended');
  assert.ok(first);
  assert.throws(() => hub.append(msg.messageId, { event: CHAT_EVENT.MESSAGE, msg: {} }), (err) => err instanceof StreamHubError && err.code === 'MESSAGE_CLOSED');
});

test('unknown messages are typed 404s, not crashes', () => {
  const hub = new SqliteStreamHub();
  assert.throws(() => hub.describe('nope'), (err) => err.code === 'MESSAGE_NOT_FOUND' && err.status === 404);
  assert.throws(() => hub.resumeFrom('nope', 0), (err) => err.code === 'MESSAGE_NOT_FOUND');
  assert.throws(() => hub.resumeFrom('nope', -1), (err) => err.status === 404); // lookup first, then cursor validation
});

// ---------------------------------------------------------------------------
// The real path: the server must work identically on the durable store.
// ---------------------------------------------------------------------------

test('the HTTP server runs on the SQLite store, and a restart can still resume the message', async () => {
  const dbPath = tmpDb();
  const port = 21000 + (process.pid % 1000);
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('store-test')}` };

  /** Boots the server on the shared database and waits for readiness. */
  const boot = async () => {
    const child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, PORT: String(port), frameDelayMs: '0', SHENSHA_STORE: 'sqlite', SHENSHA_DB: dbPath, SHENSHA_SESSION_SECRET: TEST_SECRET },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 10_000);
      child.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
      child.on('exit', () => { clearTimeout(timer); reject(new Error('server exited early')); });
    });
    return child;
  };

  let child = await boot();
  try {
    const base = `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/api/v3/demo/messages`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ content: '2000-01-01', request_id: 'durable-1' }),
    });
    assert.equal(res.status, 200);
    const messageId = res.headers.get('x-message-id');
    assert.ok(messageId);

    // Drain the whole stream: the message must end with a terminal frame.
    const text = await res.text();
    const frames = text.split('\n\n')
      .map((b) => b.split('\n').find((l) => l.startsWith('data:')))
      .filter((l) => l && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.replace(/^data:\s?/, '')));
    assert.ok(frames.length > 2);
    assert.deepEqual(frames.map((f) => f.seq), frames.map((_, i) => i + 1), 'seq 1..N, gapless');
    assert.ok(['end', 'error'].includes(frames.at(-1)?.msg?.event), 'terminal frame present');

    // Idempotent replay while the process is up.
    const replay = await fetch(`${base}/api/v3/demo/messages`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ content: '2000-01-01', request_id: 'durable-1' }),
    });
    assert.equal(replay.headers.get('x-message-id'), messageId, 'durable request_id must replay the same message');
    await replay.body?.cancel?.().catch(() => {});

    // --- the point of a durable store: kill the process, bring it back, and the
    // message must still be resumable. An in-memory hub fails exactly here.
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    child = await boot();

    const afterRestart = await fetch(`${base}/api/v3/demo/messages/${messageId}/stream?from_seq=0`, {
      headers: { authorization: `Bearer ${tokenFor('store-test')}` },
    });
    assert.equal(afterRestart.status, 200, 'the message must still exist after a restart');
    const replayed = (await afterRestart.text()).split('\n\n')
      .map((b) => b.split('\n').find((l) => l.startsWith('data:')))
      .filter((l) => l && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.replace(/^data:\s?/, '')));
    assert.deepEqual(replayed, frames, 'a restart must replay the stored frames unchanged');

    // And the durable idempotency index still answers.
    const replayAfterRestart = await fetch(`${base}/api/v3/demo/messages`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ content: '2000-01-01', request_id: 'durable-1' }),
    });
    assert.equal(replayAfterRestart.headers.get('x-message-id'), messageId, 'request_id idempotency must survive a restart');
    await replayAfterRestart.body?.cancel?.().catch(() => {});
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
