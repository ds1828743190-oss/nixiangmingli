/**
 * frames.test.mjs — wire-format round trips and, most importantly, the parser's
 * behaviour at *arbitrary chunk boundaries*.
 *
 * A stream parser that only works when a whole frame arrives in one read passes
 * every hand-written test and fails in production, so every parser test here
 * feeds the same bytes at several split points.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_FRAME,
  CHAT_EVENT,
  NdjsonParser,
  SseParser,
  SSE_DONE,
  agentFrames,
  chatFrame,
  encodeNdjson,
  encodeSse,
  encodeSseDone,
  extractSseData,
  frameEvent,
  isTerminalFrame,
  nextRetry,
  CHAT_RETRY_POLICY,
  AGENT_READER_POLICY,
} from '../src/frames.mjs';

test('agent frame constructors produce the exact observed envelope', () => {
  assert.deepEqual(agentFrames.conversationId('c1'), { type: 'conversation_id', conversationId: 'c1' });
  assert.deepEqual(agentFrames.reasoning('think'), { type: 'reasoning', content: 'think' });
  assert.deepEqual(agentFrames.phaseChange(), { type: 'phase_change' });
  assert.deepEqual(agentFrames.toolCall('t', { a: 1 }), { type: 'tool_call', toolCall: { name: 't', arguments: { a: 1 } } });
  assert.deepEqual(agentFrames.toolResult(2, { ok: true }), { type: 'tool_result', index: 2, result: { ok: true } });
  assert.deepEqual(agentFrames.content('hi'), { type: 'content', content: 'hi' });
  assert.deepEqual(agentFrames.keepAlive(), { type: 'keep-alive' });
  assert.deepEqual(agentFrames.error('boom'), { type: 'error', message: 'boom' });
});

test('NDJSON encoding is one line per frame and newline-terminated', () => {
  const line = encodeNdjson(agentFrames.content('a\nb'));
  assert.ok(line.endsWith('\n'));
  assert.equal(line.split('\n').length, 2, 'embedded newline is escaped by JSON, not literal');
});

test('NdjsonParser tolerates a chunk boundary inside a frame', () => {
  const wire = encodeNdjson(agentFrames.conversationId('c1')) + encodeNdjson(agentFrames.content('hello'));
  // Every possible single split point must yield the same two frames.
  for (let i = 1; i < wire.length; i += 1) {
    const parser = new NdjsonParser();
    const got = [...parser.push(wire.slice(0, i)), ...parser.push(wire.slice(i))];
    assert.equal(got.length, 2, `split at ${i}`);
    assert.equal(got[0].type, AGENT_FRAME.CONVERSATION_ID);
    assert.equal(got[1].content, 'hello');
    assert.equal(parser.pending, '');
  }
});

test('NdjsonParser keeps a partial frame buffered and never emits it early', () => {
  const parser = new NdjsonParser();
  assert.deepEqual(parser.push('{"type":"content","cont'), []);
  assert.equal(parser.pending, '{"type":"content","cont');
  assert.deepEqual(parser.push('ent":"x"}\n'), [{ type: 'content', content: 'x' }]);
});

test('NdjsonParser skips blank keep-alive padding but reports malformed lines', () => {
  const errors = [];
  const parser = new NdjsonParser({ onError: (line) => errors.push(line) });
  const frames = parser.push('\n\n{"type":"phase_change"}\nnot json\n');
  assert.equal(frames.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0], 'not json');
});

test('chatFrame assigns the envelope fields and rejects an invalid seq', () => {
  const f = chatFrame({ messageId: 'm1', seq: 3, event: CHAT_EVENT.MESSAGE, msg: { delta: 'x' }, retryable: true });
  assert.deepEqual(f, { messageId: 'm1', seq: 3, retryable: true, msg: { event: 'message', delta: 'x' } });
  assert.equal(frameEvent(f), 'message');
  assert.throws(() => chatFrame({ messageId: 'm1', seq: 0, event: 'message' }), RangeError);
  assert.throws(() => chatFrame({ messageId: 'm1', seq: 1.5, event: 'message' }), RangeError);
});

test('terminal detection covers end and error only', () => {
  const mk = (event) => chatFrame({ messageId: 'm', seq: 1, event });
  assert.equal(isTerminalFrame(mk(CHAT_EVENT.END)), true);
  assert.equal(isTerminalFrame(mk(CHAT_EVENT.ERROR)), true);
  assert.equal(isTerminalFrame(mk(CHAT_EVENT.START)), false);
  assert.equal(isTerminalFrame(mk(CHAT_EVENT.MESSAGE)), false);
  assert.equal(isTerminalFrame(null), false);
});

test('SSE encoding uses the "data: " prefix and a blank-line terminator', () => {
  const wire = encodeSse(chatFrame({ messageId: 'm', seq: 1, event: 'start' }));
  assert.ok(wire.startsWith('data: '));
  assert.ok(wire.endsWith('\n\n'));
  assert.equal(wire.split('\n\n').length, 2, 'exactly one terminator');
  assert.equal(encodeSseDone(), `data: ${SSE_DONE}\n\n`);
  // The body must stay on one line so the capture regex /^data:\s*(.+)$/m matches.
  assert.equal(wire.trimEnd().split('\n').length, 1);
});

test('SseParser tolerates a chunk boundary inside a frame, including inside the terminator', () => {
  const frames = [
    chatFrame({ messageId: 'm', seq: 1, event: 'start' }),
    chatFrame({ messageId: 'm', seq: 2, event: 'message', msg: { delta: 'hi' } }),
    chatFrame({ messageId: 'm', seq: 3, event: 'end', msg: { content: 'hi' } }),
  ];
  const wire = frames.map(encodeSse).join('') + encodeSseDone();
  for (let i = 1; i < wire.length; i += 1) {
    const parser = new SseParser();
    const got = [...parser.push(wire.slice(0, i)), ...parser.push(wire.slice(i))];
    assert.equal(got.length, 3, `split at ${i}`);
    assert.deepEqual(got.map((f) => f.seq), [1, 2, 3]);
    assert.equal(parser.done, true, `[DONE] sentinel at split ${i}`);
  }
});

test('SseParser ignores frames with no data line and does not treat [DONE] as a frame', () => {
  const parser = new SseParser();
  const got = parser.push(': comment\n\nevent: ping\n\ndata: [DONE]\n\n');
  assert.deepEqual(got, []);
  assert.equal(parser.done, true);
});

test('extractSseData joins multi-line data and tolerates a missing space', () => {
  assert.equal(extractSseData('data:{"a":1}'), '{"a":1}');
  assert.equal(extractSseData('data: line1\ndata: line2'), 'line1\nline2');
  assert.equal(extractSseData('event: x'), null);
});

test('retry policy is exponential, capped, and bounded by wall-clock duration', () => {
  assert.deepEqual(CHAT_RETRY_POLICY, { maxRetries: 5, baseDelayMs: 1000, maxDurationMs: 120_000 });
  assert.deepEqual(nextRetry(0, 0), { retry: true, delayMs: 1000 });
  assert.deepEqual(nextRetry(1, 0), { retry: true, delayMs: 2000 });
  assert.deepEqual(nextRetry(2, 0), { retry: true, delayMs: 4000 });
  assert.equal(nextRetry(5, 0).retry, false);
  assert.equal(nextRetry(5, 0).reason, 'max_retries');
  // The cap is a duration, not an attempt count: a late attempt must give up.
  assert.equal(nextRetry(0, 119_500).retry, false);
  assert.equal(nextRetry(0, 119_500).reason, 'max_duration');
});

test('agent reader policy matches the observed 30s/5s/3/2s numbers', () => {
  assert.deepEqual(AGENT_READER_POLICY, {
    inactivityTimeoutMs: 30_000,
    inactivityPollMs: 5_000,
    maxRetries: 3,
    retryBackoffMs: 2_000,
  });
});
