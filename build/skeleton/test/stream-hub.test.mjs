/**
 * stream-hub.test.mjs — the resume invariant.
 *
 * Everything here exists to prove one sentence: `resumeFrom(id, N)` returns
 * exactly the frames with `seq > N`, in order, with no gap and no duplicate.
 * That is the property that lets a dropped connection continue an answer
 * instead of regenerating it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { StreamHub, StreamHubError } from '../src/stream-hub.mjs';
import { CHAT_EVENT } from '../src/frames.mjs';

/** Creates a message and appends `n` message frames, returning the hub. */
function seeded(n) {
  const hub = new StreamHub();
  const message = hub.createMessage({ channel: 'demo', conversationId: 'conv-1', archiveId: 'arch-1', requestId: 'req-1' });
  for (let i = 0; i < n; i += 1) {
    hub.append(message.messageId, { event: CHAT_EVENT.MESSAGE, msg: { delta: `chunk-${i}` } });
  }
  return { hub, messageId: message.messageId };
}

test('createMessage returns a resumable identity before any frame exists', () => {
  const hub = new StreamHub();
  const m = hub.createMessage({ channel: 'zhouyi-bagua', conversationId: 'c', archiveId: 'a', requestId: 'r' });
  assert.match(m.messageId, /^msg_/);
  assert.equal(m.status, 'open');
  assert.equal(m.frames.length, 0);
  assert.equal(hub.has(m.messageId), true);
  assert.deepEqual(hub.describe(m.messageId).state, { frameCount: 0, contentChunks: 0 });
});

test('seq is assigned by the store and is strictly monotonic', () => {
  const { hub, messageId } = seeded(5);
  const seqs = hub.frames(messageId).map((f) => f.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
});

test('resumeFrom is exclusive on the cursor: no duplicate, no gap, for every N', () => {
  const total = 7;
  const { hub, messageId } = seeded(total);
  const all = hub.frames(messageId);

  for (let n = 0; n <= total; n += 1) {
    const { frames } = hub.resumeFrom(messageId, n);
    // Exactly the missing tail.
    assert.deepEqual(frames.map((f) => f.seq), all.slice(n).map((f) => f.seq), `from_seq=${n}`);
    // No duplicate: nothing at or below the cursor is replayed.
    assert.ok(frames.every((f) => f.seq > n), `from_seq=${n} replayed a seen frame`);
    // No gap: contiguous.
    frames.forEach((f, i) => {
      if (i > 0) assert.equal(f.seq, frames[i - 1].seq + 1, `gap after from_seq=${n}`);
    });
  }
});

test('a two-part resume covers the stream exactly once (union has no overlap)', () => {
  const { hub, messageId } = seeded(6);
  const firstHalf = hub.resumeFrom(messageId, 0).frames.slice(0, 2); // client rendered up to seq 2
  const cursor = firstHalf.at(-1).seq;
  const secondHalf = hub.resumeFrom(messageId, cursor).frames;
  const union = [...firstHalf, ...secondHalf].map((f) => f.seq);
  assert.deepEqual(union, [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(union).size, union.length, 'no frame replayed twice');
  assert.equal(hub.resumeFrom(messageId, cursor).frames.length + cursor, 6, 'no frame lost');
});

test('a cursor beyond the last seq yields an empty tail, not an error', () => {
  const { hub, messageId } = seeded(3);
  const result = hub.resumeFrom(messageId, 99);
  assert.deepEqual(result.frames, []);
  assert.equal(result.lastSeq, 3);
  assert.equal(result.terminal, null);
});

test('end frame is terminal; appending after it is refused', () => {
  const { hub, messageId } = seeded(2);
  const end = hub.append(messageId, { event: CHAT_EVENT.END, msg: { content: 'chunk-0chunk-1' } });
  assert.equal(end.seq, 3);
  assert.equal(hub.describe(messageId).status, 'complete');
  assert.throws(
    () => hub.append(messageId, { event: CHAT_EVENT.MESSAGE, msg: { delta: 'late' } }),
    (err) => err instanceof StreamHubError && err.code === 'MESSAGE_CLOSED' && err.status === 409,
  );
});

test('resume after completion replays the tail INCLUDING the terminal frame, then stops', () => {
  const { hub, messageId } = seeded(3);
  hub.append(messageId, { event: CHAT_EVENT.END, msg: { content: 'done' } });
  const result = hub.resumeFrom(messageId, 2);
  assert.deepEqual(result.frames.map((f) => f.seq), [3, 4]);
  assert.equal(result.status, 'complete');
  assert.equal(result.terminal.seq, 4);
  assert.equal(result.terminal.msg.event, CHAT_EVENT.END);
});

test('error frames are terminal and carry retryability through to the client', () => {
  const { hub, messageId } = seeded(1);
  const err = hub.append(messageId, { event: CHAT_EVENT.ERROR, msg: { code: 'UPSTREAM_TIMEOUT' }, retryable: true });
  assert.equal(err.retryable, true);
  const described = hub.describe(messageId);
  assert.equal(described.status, 'error');
  assert.equal(described.retryable, true);
  // Retryable means "reconnect and resume", not "regenerate" — the frames are still there.
  assert.equal(hub.resumeFrom(messageId, 0).frames.length, 2);
});

test('replay is deterministic: the same cursor twice returns identical frames', () => {
  const { hub, messageId } = seeded(4);
  const a = JSON.stringify(hub.resumeFrom(messageId, 1).frames);
  const b = JSON.stringify(hub.resumeFrom(messageId, 1).frames);
  assert.equal(a, b);
});

test('unknown message and bad cursors are typed 4xx errors, not crashes', () => {
  const empty = new StreamHub();
  assert.throws(
    () => empty.resumeFrom('nope', 0),
    (err) => err.code === 'MESSAGE_NOT_FOUND' && err.status === 404,
  );
  const { hub, messageId } = seeded(1);
  assert.throws(() => hub.resumeFrom(messageId, -1), (err) => err.code === 'INVALID_FROM_SEQ');
  assert.throws(() => hub.resumeFrom(messageId, 1.5), (err) => err.code === 'INVALID_FROM_SEQ');
  assert.throws(() => hub.createMessage({ channel: '' }), (err) => err.code === 'CHANNEL_REQUIRED');
});

test('a message carries the billing identity (messageId) from creation, so retries are not recharges', () => {
  const hub = new StreamHub();
  const m = hub.createMessage({ channel: 'dasiming', conversationId: 'c', archiveId: 'a', requestId: 'same-request-id' });
  // Two resumes of the same messageId never create a second message.
  hub.resumeFrom(m.messageId, 0);
  hub.resumeFrom(m.messageId, 0);
  assert.equal(hub.size, 1);
  assert.equal(hub.describe(m.messageId).requestId, 'same-request-id');
});

test('markError records a transport-level abort without inventing a frame the client never saw', () => {
  const { hub, messageId } = seeded(2);
  const after = hub.markError(messageId, 'client_disconnected');
  assert.equal(after.status, 'error');
  assert.equal(after.lastSeq, 2, 'no frame was added');
  assert.equal(after.state.abortReason, 'client_disconnected');
});
