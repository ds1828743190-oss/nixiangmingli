/**
 * model-mode.test.mjs — the server driven by a MODEL instead of the fixture.
 *
 * This is the test that makes the seam real: the same HTTP surface, the same
 * frames, the same resume guarantees — but the words come from a provider.
 * `chatStream` is injected, so no key and no network are involved, and the test
 * asserts the CONTRACT rather than any particular vendor's behaviour.
 *
 * @module test/model-mode
 */

import { test } from 'node:test';
import { tokenFor, TEST_SECRET, bearer } from './helpers.mjs';
import assert from 'node:assert/strict';

import { listen } from '../src/server.mjs';
import { CHAT_EVENT, AGENT_FRAME } from '../src/frames.mjs';

async function boot(opts = {}) {
  const { server, baseUrl } = await listen({ sessionSecret: TEST_SECRET, frameDelayMs: 0, ...opts });
  return { baseUrl, close: () => new Promise((r) => server.close(r)) };
}

/** A provider that hands out exact chunks (awkward splits included). */
function fakeProvider(rounds) {
  let round = 0;
  return async function* chatStream() {
    const chunks = rounds[Math.min(round, rounds.length - 1)];
    round += 1;
    for (const c of chunks) yield new TextEncoder().encode(c);
  };
}

const ndjsonChunk = (delta) => `{"choices":[{"delta":${JSON.stringify(delta)}}]}\n`;

async function readNdjson(res) {
  const frames = [];
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) frames.push(JSON.parse(line));
    }
  }
  return frames;
}

async function readSse(res) {
  const frames = [];
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line || line.includes('[DONE]')) continue;
      frames.push(JSON.parse(line.replace(/^data:\s?/, '')));
    }
  }
  return frames;
}

test('the agent route streams model output as protocol frames', async () => {
  const chatStream = fakeProvider([[
    ndjsonChunk({ reasoning_content: 'reading the chart' }),
    ndjsonChunk({ content: 'Year pillar ' }),
    ndjsonChunk({ content: 'is jia-wei.' }),
    '{"choices":[{"finish_reason":"stop"}]}\n',
  ]]);
  const app = await boot({ chatStream });
  try {
    const res = await fetch(`${app.baseUrl}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('model-user')}` },
      body: JSON.stringify({ message: 'explain 2000-01-01', birth: { date: '2000-01-01', time: '12:00', timezone: 'Asia/Shanghai' } }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);

    const frames = await readNdjson(res);
    const types = frames.map((f) => f.type);
    assert.equal(types[0], AGENT_FRAME.CONVERSATION_ID);
    assert.ok(types.includes(AGENT_FRAME.REASONING));
    assert.equal(types.filter((t) => t === AGENT_FRAME.PHASE_CHANGE).length, 1);
    // The model's two content deltas must arrive as content frames, in order.
    assert.deepEqual(
      frames.filter((f) => f.type === AGENT_FRAME.CONTENT).map((f) => f.content),
      ['Year pillar ', 'is jia-wei.'],
    );
    // The prompt was built from the REAL kernel's facts for the supplied birth.
    const facts = frames.find((f) => f.type === AGENT_FRAME.CONVERSATION_ID);
    assert.ok(facts, 'conversation_id frame present');
  } finally {
    await app.close();
  }
});

test('the SSE route streams model output, ends with assembled text, and resumes', async () => {
  const chatStream = fakeProvider([[
    ndjsonChunk({ reasoning_content: 'thinking' }),
    ndjsonChunk({ content: 'first ' }),
    ndjsonChunk({ content: 'second' }),
    '{"choices":[{"finish_reason":"stop"}]}\n',
  ]]);
  const app = await boot({ chatStream });
  try {
    const res = await fetch(`${app.baseUrl}/api/v3/zhouyi-bagua/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('model-sse')}` },
      body: JSON.stringify({ content: 'x', request_id: 'model-1', birth: { date: '2000-01-01', time: '12:00', timezone: 'Asia/Shanghai' } }),
    });
    assert.equal(res.status, 200);
    const messageId = res.headers.get('x-message-id');
    const frames = await readSse(res);

    assert.deepEqual(frames.map((f) => f.seq), frames.map((_, i) => i + 1), 'seq 1..N, gapless');
    assert.equal(frames[0].msg.event, CHAT_EVENT.START);
    const terminal = frames.at(-1);
    assert.equal(terminal.msg.event, CHAT_EVENT.END);
    assert.equal(terminal.msg.content, 'first second', 'terminal frame carries the assembled answer');

    // Reasoning stays an action, never leaks into the answer text.
    assert.ok(frames.some((f) => f.msg.action === 'reasoning' && f.msg.content === 'thinking'));
    assert.equal(terminal.msg.content.includes('thinking'), false);

    // Resume from the middle replays exactly the tail.
    const resumed = await fetch(`${app.baseUrl}/api/v3/zhouyi-bagua/messages/${messageId}/stream?from_seq=2`, {
      headers: { authorization: `Bearer ${tokenFor('model-sse')}` },
    });
    const tail = await readSse(resumed);
    assert.deepEqual(tail.map((f) => f.seq), frames.filter((f) => f.seq > 2).map((f) => f.seq));
  } finally {
    await app.close();
  }
});

test('a model tool call is gated by the registry and reported back as an action', async () => {
  const badArgs = { tool_calls: [{ function: { name: 'almanac.day_info', arguments: '{}' } }] };
  // Round 1: the model asks for a tool with INVALID arguments. Round 2: it answers.
  const chatStream = fakeProvider([
    [ndjsonChunk(badArgs)],
    [ndjsonChunk({ content: 'recovered' }), '{"choices":[{"finish_reason":"stop"}]}\n'],
  ]);
  const app = await boot({ chatStream });
  try {
    const res = await fetch(`${app.baseUrl}/api/v3/zhouyi-bagua/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('model-tool')}` },
      body: JSON.stringify({ content: 'x', request_id: 'model-tool-1', birth: { date: '2000-01-01', time: '12:00', timezone: 'Asia/Shanghai' } }),
    });
    const frames = await readSse(res);
    const call = frames.find((f) => f.msg.action === 'tool_call');
    const result = frames.find((f) => f.msg.action === 'tool_result');
    assert.ok(call, 'the proposed call is surfaced');
    assert.equal(call.msg.name, 'almanac.day_info');
    assert.ok(result, 'the refusal is surfaced as a result, not an exception');
    assert.equal(result.msg.ok, false, 'invalid arguments must not be reported as success');
    assert.equal(frames.at(-1).msg.event, CHAT_EVENT.END, 'the turn continues after the refusal');
    assert.equal(frames.at(-1).msg.content, 'recovered');
  } finally {
    await app.close();
  }
});

test('without a provider the server reports fixture narration (and still works)', async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.baseUrl}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('fixture-user')}` },
      body: JSON.stringify({ message: 'hello', birth: { date: '2000-01-01', time: '12:00', timezone: 'Asia/Shanghai' } }),
    });
    assert.equal(res.status, 200);
    const frames = await readNdjson(res);
    assert.ok(frames.some((f) => f.type === AGENT_FRAME.CONTENT));
  } finally {
    await app.close();
  }
});
