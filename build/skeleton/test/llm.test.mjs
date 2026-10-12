/**
 * llm.test.mjs — the model seam, driven entirely by a fake stream.
 *
 * No network, no API key: `chatStream` is injected, which is exactly why this
 * module was written around an injected stream instead of a hard-coded provider.
 * What is under test is the CONTRACT the model must satisfy, not any one vendor.
 *
 * @module test/llm
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_FRAME, narrateWithModel, readWireEvents, toWireEvent, systemPrompt, createChatStream } from '../src/llm.mjs';
import { computeFacts } from '../src/kernel-active.mjs';
import { ToolRegistry } from '../src/tools.mjs';

const FACTS = computeFacts({ date: '1990-05-17', time: '08:30', timezone: 'Asia/Shanghai' });

/** A stream that hands out exact byte chunks, including deliberately awkward splits. */
function streamOf(parts) {
  return async function* () {
    for (const p of parts) yield new TextEncoder().encode(p);
  };
}

/** Collects every frame from a narration. */
async function collect(gen) {
  const out = [];
  for await (const f of gen) out.push(f);
  return out;
}

/** Registry with a spied handler so "the gate" can be checked, not trusted. */
function spyRegistry() {
  const reg = new ToolRegistry();
  const state = { calls: 0 };
  reg.register({
    name: 'almanac.day_info',
    description: 'Deterministic day metadata.',
    scopes: ['almanac'],
    effects: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['date'],
      properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
    },
    handler: (args) => { state.calls += 1; return { date: args.date, source: 'spy' }; },
  });
  return { reg, state };
}

// ---------------------------------------------------------------------------
// wire parsing
// ---------------------------------------------------------------------------

test('readWireEvents reassembles NDJSON split mid-object across chunks', async () => {
  const frames = [];
  for await (const ev of readWireEvents(streamOf([
    '{"choices":[{"delta":{"reasoning_content":"thin',
    'king"}}]}\n{"choices":[{"delta":{"content":"Hel',
    'lo"}}]}\n',
  ])())) frames.push(ev);

  assert.deepEqual(frames, [
    { type: 'reasoning', text: 'thinking' },
    { type: 'content', text: 'Hello' },
  ]);
});

test('readWireEvents parses SSE framing as well as NDJSON', async () => {
  const frames = [];
  for await (const ev of readWireEvents(streamOf([
    'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
  ])())) frames.push(ev);
  assert.deepEqual(frames.map((f) => f.text), ['a', 'b']);
});

test('toWireEvent separates thinking from the answer and parses tool arguments', () => {
  assert.deepEqual(toWireEvent({ choices: [{ delta: { reasoning_content: 'r' } }] }), { type: 'reasoning', text: 'r' });
  assert.deepEqual(toWireEvent({ choices: [{ delta: { reasoning: 'r2' } }] }), { type: 'reasoning', text: 'r2' });
  assert.deepEqual(toWireEvent({ choices: [{ delta: { content: 'c' } }] }), { type: 'content', text: 'c' });
  // A provider that sends both must not leak thinking into the answer pane.
  assert.equal(toWireEvent({ choices: [{ delta: { reasoning_content: 'r', content: 'c' } }] }).type, 'reasoning');
  assert.deepEqual(
    toWireEvent({ choices: [{ delta: { tool_calls: [{ function: { name: 'x.y', arguments: '{"a":1}' } }] } }] }),
    { type: 'tool_call', call: { name: 'x.y', arguments: { a: 1 } } },
  );
  assert.equal(toWireEvent({ choices: [{ finish_reason: 'stop' }] }).type, 'done');
  assert.equal(toWireEvent({ nothing: true }), null);
});

// ---------------------------------------------------------------------------
// narration contract
// ---------------------------------------------------------------------------

test('narration opens with conversation_id, then reasoning, one phase_change, content, keep-alive', async () => {
  const chatStream = streamOf([
    '{"choices":[{"delta":{"reasoning_content":"looking at the four pillars"}}]}\n',
    '{"choices":[{"delta":{"reasoning_content":"they are as given"}}]}\n',
    '{"choices":[{"delta":{"content":"Year pillar: "}}]}\n',
    '{"choices":[{"delta":{"content":"jia-wei."}}]}\n',
    '{"choices":[{"finish_reason":"stop"}]}\n',
  ]);
  const frames = await collect(narrateWithModel({ facts: FACTS, registry: spyRegistry().reg, surface: 'almanac', chatStream }));
  const types = frames.map((f) => f.type);

  assert.equal(types[0], AGENT_FRAME.CONVERSATION_ID);
  assert.equal(types[1], AGENT_FRAME.REASONING);
  assert.equal(types.filter((t) => t === AGENT_FRAME.PHASE_CHANGE).length, 1, 'exactly one phase_change');
  assert.ok(types.indexOf(AGENT_FRAME.PHASE_CHANGE) < types.indexOf(AGENT_FRAME.CONTENT));
  assert.equal(types.at(-1), AGENT_FRAME.KEEP_ALIVE);
  assert.equal(types.includes(AGENT_FRAME.ERROR), false);
  assert.deepEqual(
    frames.filter((f) => f.type === AGENT_FRAME.CONTENT).map((f) => f.content),
    ['Year pillar: ', 'jia-wei.'],
  );
});

test('the prompt hands the model resolved facts and forbids recomputation', () => {
  const p = systemPrompt(FACTS);
  assert.match(p, /FACTS \(authoritative, do not recompute\)/);
  assert.match(p, /never compute, correct, or "fix"/);
  // Kernel-agnostic: whatever kernel is active, its own resolved values must be
  // in the prompt (a hardcoded pillar would only prove the stub works).
  assert.ok(p.includes(FACTS.fourPillars.day.ganzhi), 'day pillar from the active kernel must appear');
  assert.ok(p.includes(FACTS.input.date), 'the resolved date must appear');
  assert.ok(p.includes(FACTS.kernelVersion), 'the kernel version must appear so a report can be traced');
});

// ---------------------------------------------------------------------------
// the tool gate
// ---------------------------------------------------------------------------

test('an invalid tool call is refused, never dispatched, and reported back as typed data', async () => {
  const { reg, state } = spyRegistry();
  let round = 0;
  const chatStream = async function* () {   // second round answers in prose
    round += 1;
    if (round === 1) {
      yield new TextEncoder().encode('{"choices":[{"delta":{"tool_calls":[{"function":{"name":"almanac.day_info","arguments":"{}"}}]}}]}\n');
    } else {
      yield new TextEncoder().encode('{"choices":[{"delta":{"content":"done"}}]}\n');
    }
  };
  const frames = await collect(narrateWithModel({ facts: FACTS, registry: reg, surface: 'almanac', chatStream, question: 'what day?' }));

  assert.equal(state.calls, 0, 'handler must not run for invalid arguments');
  const call = frames.find((f) => f.type === AGENT_FRAME.TOOL_CALL);
  const result = frames.find((f) => f.type === AGENT_FRAME.TOOL_RESULT);
  assert.ok(call && result, 'a call and its result must both be emitted');
  assert.equal(result.result.ok, false);
  assert.equal(typeof result.result.code, 'string');
  assert.ok(frames.some((f) => f.type === AGENT_FRAME.CONTENT), 'the turn continues after the refusal');
});

test('a valid tool call runs the handler and the result carries its value', async () => {
  const { reg, state } = spyRegistry();
  let round = 0;
  const chatStream = async function* () {
    round += 1;
    if (round === 1) {
      yield new TextEncoder().encode('{"choices":[{"delta":{"tool_calls":[{"function":{"name":"almanac.day_info","arguments":"{\\"date\\":\\"1990-05-17\\"}"}}]}}]}\n');
    } else {
      yield new TextEncoder().encode('{"choices":[{"delta":{"content":"ok"}}]}\n');
    }
  };
  const frames = await collect(narrateWithModel({ facts: FACTS, registry: reg, surface: 'almanac', chatStream }));
  assert.equal(state.calls, 1);
  const result = frames.find((f) => f.type === AGENT_FRAME.TOOL_RESULT);
  assert.equal(result.result.ok, true);
  assert.deepEqual(result.result.result, { date: '1990-05-17', source: 'spy' });
});

test('a looping model is capped by maxToolRounds', async () => {
  const { reg, state } = spyRegistry();
  const chatStream = async function* () {   // always asks for another tool
    yield new TextEncoder().encode('{"choices":[{"delta":{"tool_calls":[{"function":{"name":"almanac.day_info","arguments":"{\\"date\\":\\"1990-05-17\\"}"}}]}}]}\n');
  };
  const frames = await collect(narrateWithModel({ facts: FACTS, registry: reg, surface: 'almanac', chatStream, maxToolRounds: 2 }));
  assert.equal(state.calls, 3, 'initial round + 2 tool rounds, then stop');
  assert.equal(frames.at(-1).type, AGENT_FRAME.KEEP_ALIVE);
});

test('an aborted turn stops emitting instead of finishing the stream', async () => {
  const controller = new AbortController();
  const chatStream = async function* () {
    yield new TextEncoder().encode('{"choices":[{"delta":{"reasoning_content":"a"}}]}\n');
    controller.abort();
    yield new TextEncoder().encode('{"choices":[{"delta":{"content":"should not appear"}}]}\n');
  };
  const frames = await collect(narrateWithModel({ facts: FACTS, registry: spyRegistry().reg, surface: 'almanac', chatStream, signal: controller.signal }));
  assert.equal(frames.some((f) => f.type === AGENT_FRAME.CONTENT), false);
});

test('a provider error becomes an error frame, not an exception', async () => {
  const chatStream = streamOf(['{"error":{"message":"rate limited"}}\n']);
  const frames = await collect(narrateWithModel({ facts: FACTS, registry: spyRegistry().reg, surface: 'almanac', chatStream }));
  const err = frames.find((f) => f.type === AGENT_FRAME.ERROR);
  assert.equal(err.message, 'rate limited');
});

// ---------------------------------------------------------------------------
// provider adapter hygiene
// ---------------------------------------------------------------------------

test('createChatStream refuses to be built without a key', () => {
  assert.throws(() => createChatStream({ baseUrl: 'https://example.invalid/v1', apiKey: '', model: 'm' }), /apiKey/);
});

test('a provider failure never echoes the API key', async () => {
  const key = 'sk-secret-value-must-not-leak';
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => '{"error":"bad key sk-secret-value-must-not-leak"}' });
  const chatStream = createChatStream({ baseUrl: 'https://example.invalid/v1', apiKey: key, model: 'm', fetchImpl: fakeFetch });
  await assert.rejects(async () => { for await (const _ of chatStream({ messages: [] })) { /* noop */ } }, (err) => {
    assert.match(err.message, /HTTP 401/);
    // The provider echoed the key back in its own error body; we must not repeat it.
    assert.equal(err.message.includes(key), false, 'the key must be redacted from the surfaced error');
    return true;
  });
});
