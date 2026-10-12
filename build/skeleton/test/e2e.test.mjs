/**
 * e2e.test.mjs — boots a real server on an ephemeral port and exercises every
 * endpoint over real HTTP.
 *
 * These tests deliberately talk to the socket rather than calling the handlers
 * directly, because the parts of this contract that actually break in
 * production are transport-level: chunk boundaries, flush timing, disconnect,
 * resume, and status codes. A handler-level unit test cannot see any of them.
 *
 * Each test starts a fresh server so quotas and the message store are isolated
 * (a shared store would make test order significant).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.mjs';
import { tokenFor, TEST_SECRET } from './helpers.mjs';
import { ToolRegistry } from '../src/tools.mjs';
import { NdjsonParser, SseParser, CHAT_EVENT } from '../src/frames.mjs';
import { computeFacts, narrationPrompt } from '../src/kernel-active.mjs';

/** Boots a server and returns a helper object; always closed by the caller. */
async function boot(opts = {}) {
  const server = createServer({ sessionSecret: TEST_SECRET, ...opts });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${port}`;
  return {
    server,
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** POSTs JSON and returns the parsed response body. */
async function postJson(base, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') ?? '';
  // The chat route answers 200 with a stream — that is a success, not a body to
  // parse. Only JSON responses are parsed; anything else is a protocol surprise
  // and is reported with the offending route and status.
  if (!contentType.includes('json')) {
    const preview = (await res.text()).slice(0, 60);
    return { status: res.status, headers: res.headers, body: null, streamed: true, preview };
  }
  return { status: res.status, headers: res.headers, body: await res.json(), streamed: false };
}

/** Asserts an envelope is a JSON error with the given code and status. */
function assertTypedError(res, status, code) {
  assert.equal(res.status, status, `expected HTTP ${status}, got ${res.status} (${res.preview ?? ''})`);
  assert.equal(res.streamed, false, 'a refusal must not be a stream');
  assert.equal(res.body.code, code);
  assert.equal(res.body.status, status);
}

/** Reads a whole NDJSON response into an array of frames. */
async function readNdjson(res) {
  const parser = new NdjsonParser();
  const frames = [];
  for await (const chunk of res.body) {
    frames.push(...parser.push(Buffer.from(chunk).toString('utf8')));
  }
  return { frames, pending: parser.pending };
}

/** Reads a whole SSE response into an array of frames. */
async function readSse(res) {
  const parser = new SseParser();
  const frames = [];
  for await (const chunk of res.body) {
    frames.push(...parser.push(Buffer.from(chunk).toString('utf8')));
  }
  return { frames, parser };
}

/**
 * Reads an SSE response until `stopAfter` frames have been rendered, then kills
 * the socket — simulating a client that vanishes mid-answer.
 *
 * A transport read typically returns *several* frames at once, so this function
 * deliberately renders only `stopAfter` of them and reports the rest as
 * `unread`. That distinction is the whole point of the resume test: `lastSeq`
 * must be the seq the client actually *rendered*, not the seq that happened to
 * arrive in the last buffer, and `unread` represents bytes the client lost when
 * the connection died.
 *
 * @returns {{frames: object[], unread: object[], lastSeq: number}}
 */
async function readSseThenAbort(res, stopAfter) {
  const parser = new SseParser();
  const received = [];
  const reader = res.body.getReader();
  try {
    while (received.length < stopAfter) {
      const { value, done } = await reader.read();
      if (done) break;
      received.push(...parser.push(Buffer.from(value).toString('utf8')));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const frames = received.slice(0, stopAfter);
  return { frames, unread: received.slice(stopAfter), lastSeq: frames.at(-1)?.seq ?? 0 };
}

/** The tail of a stream, truncated at (and including) the first terminal frame. */
function throughTerminal(frames) {
  const out = [];
  for (const f of frames) {
    out.push(f);
    if (f.msg?.event === CHAT_EVENT.END || f.msg?.event === CHAT_EVENT.ERROR) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1) NDJSON agent stream
// ---------------------------------------------------------------------------
test('1) POST /api/agent/chat streams NDJSON frames in the contracted order', async () => {
  const app = await boot({ frameDelayMs: 2 });
  try {
    const res = await fetch(`${app.base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('acct-1')}` },
      body: JSON.stringify({ conversationId: null, message: 'tell me about 2000-01-01', timezone: 'Asia/Shanghai', language: 'zh' }),
    });

    assert.equal(res.status, 200);
    // text/plain, NOT text/event-stream — this is the distinguishing fact of route A.
    const contentType = res.headers.get('content-type') ?? '';
    assert.match(contentType, /^text\/plain/);
    assert.equal(contentType.includes('event-stream'), false, 'route A must not be SSE');

    const { frames, pending } = await readNdjson(res);
    assert.equal(pending, '', 'no partial frame left in the buffer');

    const types = frames.map((f) => f.type);
    assert.equal(types[0], 'conversation_id');
    assert.equal(types.at(-1), 'keep-alive');

    // The exact ordering contract: reasoning (0..n) -> phase_change -> tool_call
    // then tool_result (paired, index-aligned) -> content (1..n).
    const first = (t) => types.indexOf(t);
    const last = (t) => types.lastIndexOf(t);
    assert.ok(first('reasoning') > first('conversation_id'));
    assert.ok(first('phase_change') > last('reasoning'), 'phase_change closes the reasoning phase');
    assert.ok(first('tool_call') > first('phase_change'));
    assert.ok(first('tool_result') > first('tool_call'));
    assert.ok(first('content') > last('tool_result'), 'prose comes after the last tool result');

    // tool_call/tool_result must be paired and index-aligned, or the client's
    // `toolCalls[index]` back-fill silently drops a result.
    const calls = frames.filter((f) => f.type === 'tool_call');
    const results = frames.filter((f) => f.type === 'tool_result');
    assert.ok(calls.length >= 1);
    assert.equal(calls.length, results.length);
    assert.deepEqual(results.map((r) => r.index), calls.map((_, i) => i));
    assert.ok(results.every((r) => r.result.ok === true), 'stub tools should all succeed');

    const content = frames.filter((f) => f.type === 'content').map((f) => f.content).join('');
    assert.ok(content.length > 0);
    // The prose may only restate facts the kernel produced.
    const facts = computeFacts({ date: '2000-01-01', time: '12:00', timezone: 'Asia/Shanghai' });
    assert.ok(content.includes(facts.fourPillars.day.ganzhi), 'narration must quote the kernel values');
    assert.ok(content.includes('adds no calculation of its own'));
  } finally {
    await app.close();
  }
});

test('1b) /api/agent/chat requires a principal: anonymous callers get 401, same as the SSE agent route', async () => {
  const app = await boot();
  try {
    // One condition, one answer (PROTOCOL.md §6). The remedy for "no credentials"
    // is a sign-in, not a purchase, so this must not be reported as a quota 403.
    const res = await postJson(app.base, '/api/agent/chat', { message: 'hi', timezone: 'UTC' });
    assertTypedError(res, 401, 'UNAUTHENTICATED');

    // And the anonymous snapshot must agree, so the client never shows a composer
    // for a capability the server will refuse.
    const access = await (await fetch(`${app.base}/api/access`)).json();
    assert.equal(access.signInRequired, true);
    assert.equal(access.agentTrial.hasRemaining, false);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 2) SSE chat stream
// ---------------------------------------------------------------------------
test('2) POST /api/v3/:channel/messages emits data:-prefixed frames ordered by seq, ending with a terminal frame', async () => {
  const app = await boot({ frameDelayMs: 2 });
  try {
    const res = await fetch(`${app.base}/api/v3/zhouyi-bagua/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${tokenFor('acct-2')}` },
      body: JSON.stringify({ content: 'explain 2000-01-01', conversation_id: 'conv-7', archive_id: 'arch-1', request_id: 'req-1' }),
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
    const messageId = res.headers.get('x-message-id');
    assert.ok(messageId, 'messageId is announced in a header so a client that dies before frame 1 can still resume');

    // Read raw text first: the `data:` prefix is part of the contract, so assert
    // on bytes, not only on the parsed result.
    const raw = await res.text();
    assert.ok(raw.endsWith('data: [DONE]\n\n'));
    const blocks = raw.split('\n\n').filter((b) => b.trim() !== '');
    for (const block of blocks) {
      assert.ok(block.startsWith('data: '), `every block is data:-prefixed, got: ${block.slice(0, 40)}`);
    }

    const { frames } = await readSse(new Response(raw));
    const events = frames.map((f) => f.msg.event);
    assert.equal(events[0], CHAT_EVENT.START);
    assert.ok(events.includes(CHAT_EVENT.MESSAGE));
    assert.ok(events.includes(CHAT_EVENT.ACTION));
    assert.ok(events.includes(CHAT_EVENT.END));
    assert.equal(events.at(-1), CHAT_EVENT.END, 'the terminal frame is last');

    // seq is monotonic and gapless from 1.
    assert.deepEqual(frames.map((f) => f.seq), frames.map((_, i) => i + 1));
    assert.ok(frames.every((f) => f.messageId === messageId));
    // retryable is about transport recovery, not content: only real failures set it.
    assert.equal(frames.at(-1).retryable, false);

    const end = frames.at(-1);
    const assembled = frames.filter((f) => f.msg.event === CHAT_EVENT.MESSAGE).map((f) => f.msg.delta).join('');
    assert.equal(end.msg.content, assembled, 'the terminal frame carries the assembled text for late joiners');
  } finally {
    await app.close();
  }
});

test('2b) the chat stream requires authentication (401, not 403)', async () => {
  const app = await boot();
  try {
    const res = await postJson(app.base, '/api/v3/zhouyi-bagua/messages', { content: 'hi', conversation_id: 'c', archive_id: '', request_id: 'r' });
    assertTypedError(res, 401, 'UNAUTHENTICATED');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 3) Resume
// ---------------------------------------------------------------------------
test('3) resume: GET .../stream?from_seq=N returns exactly the missing frames — no gap, no duplicate', async () => {
  // A slow-ish producer so the abort genuinely lands mid-generation.
  const app = await boot({ frameDelayMs: 8 });
  try {
    const post = await fetch(`${app.base}/api/v3/zhouyi-bagua/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('acct-3')}` },
      body: JSON.stringify({ content: 'explain 2000-01-01', conversation_id: 'conv-8', archive_id: 'a', request_id: 'r' }),
    });
    const messageId = post.headers.get('x-message-id');

    // --- part 1: render the first few frames, then drop the connection.
    // A real socket hands over several frames per read, so this helper renders a
    // fixed prefix and discards the rest as "bytes the client lost". The cursor
    // is therefore the last *rendered* seq, exactly as a real client would track
    // it — not the last seq that happened to arrive.
    const part1 = await readSseThenAbort(post, 3);
    assert.equal(part1.frames.length, 3);
    assert.equal(part1.frames[0].msg.event, CHAT_EVENT.START);
    const cursor = part1.lastSeq;
    assert.equal(cursor, 3);

    // Give the server a moment to observe the disconnect and close the message.
    await new Promise((r) => setTimeout(r, 50));

    // --- part 2: the client comes back and asks for everything after seq 4.
    const resumeRes = await fetch(`${app.base}/api/v3/zhouyi-bagua/messages/${messageId}/stream?from_seq=${cursor}`, {
      headers: { authorization: `Bearer ${tokenFor('acct-3')}` },
    });
    assert.equal(resumeRes.status, 200);
    assert.match(resumeRes.headers.get('content-type') ?? '', /^text\/event-stream/);

    const { frames: resumedRaw } = await readSse(resumeRes);
    const resumed = throughTerminal(resumedRaw);

    // no duplicate: nothing at or below the cursor comes back
    assert.ok(resumed.every((f) => f.seq > cursor), 'resume replayed an already-rendered frame');
    assert.deepEqual(resumed.map((f) => f.seq), resumed.map((_, i) => resumed[0].seq + i), 'gapless');

    // no gap: the union of part1 + resumed is a contiguous run from 1..last
    const union = [...part1.frames.map((f) => f.seq), ...resumed.map((f) => f.seq)];
    assert.deepEqual(union, Array.from({ length: union.length }, (_, i) => i + 1));
    assert.equal(new Set(union).size, union.length, 'a frame was delivered twice');

    // the resumed stream still terminates properly
    const lastEvent = resumed.at(-1).msg.event;
    assert.ok([CHAT_EVENT.END, CHAT_EVENT.ERROR].includes(lastEvent), `expected a terminal frame, got ${lastEvent}`);
    assert.equal(resumed.at(-1).messageId, messageId);

    // --- idempotence: resuming the finished message again replays the same tail
    const againRes = await fetch(`${app.base}/api/v3/zhouyi-bagua/messages/${messageId}/stream?from_seq=${cursor}`, {
      headers: { authorization: `Bearer ${tokenFor('acct-3')}` },
    });
    const { frames: againRaw } = await readSse(againRes);
    assert.deepEqual(throughTerminal(againRaw), resumed, 'a second resume produced a different ending');
  } finally {
    await app.close();
  }
});

test('3b) resuming from the last complete seq of a finished message returns only the terminal frame', async () => {
  const app = await boot();
  try {
    const post = await fetch(`${app.base}/api/v3/zhouyi-bagua/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('acct-3b')}` },
      body: JSON.stringify({ content: 'explain 2000-01-01', conversation_id: 'c', archive_id: 'a', request_id: 'r' }),
    });
    const messageId = post.headers.get('x-message-id');
    const { frames: all } = await readSse(post);
    assert.equal(all.at(-1).msg.event, CHAT_EVENT.END);

    const beforeEnd = all.at(-2).seq;
    const res = await fetch(`${app.base}/api/v3/zhouyi-bagua/messages/${messageId}/stream?from_seq=${beforeEnd}`, {
      headers: { authorization: `Bearer ${tokenFor('acct-3b')}` },
    });
    const { frames } = await readSse(res);
    assert.deepEqual(frames.map((f) => f.seq), [all.at(-1).seq]);
    assert.equal(frames[0].msg.event, CHAT_EVENT.END, 'an already-complete message returns the terminal frame then ends');

    // A cursor at the very end yields nothing at all — not an error, not a hang.
    const atEnd = await fetch(`${app.base}/api/v3/zhouyi-bagua/messages/${messageId}/stream?from_seq=${all.at(-1).seq}`, {
      headers: { authorization: `Bearer ${tokenFor('acct-3b')}` },
    });
    const { frames: empty } = await readSse(atEnd);
    assert.deepEqual(empty, []);
  } finally {
    await app.close();
  }
});

test('3c) resume is scoped by channel and rejects a bad cursor', async () => {
  const app = await boot();
  try {
    const post = await fetch(`${app.base}/api/v3/zhouyi-bagua/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('acct-3c')}` },
      body: JSON.stringify({ content: 'x', conversation_id: 'c', archive_id: 'a', request_id: 'r' }),
    });
    const messageId = post.headers.get('x-message-id');
    await post.text();

    const wrongChannel = await fetch(`${app.base}/api/v3/dasiming/messages/${messageId}/stream?from_seq=0`, {
      headers: { authorization: `Bearer ${tokenFor('acct-3c')}` },
    });
    assert.equal(wrongChannel.status, 404);
    assert.equal((await wrongChannel.json()).code, 'MESSAGE_NOT_FOUND');

    const badCursor = await fetch(`${app.base}/api/v3/zhouyi-bagua/messages/${messageId}/stream?from_seq=-1`, {
      headers: { authorization: `Bearer ${tokenFor('acct-3c')}` },
    });
    assert.equal(badCursor.status, 400);
    assert.equal((await badCursor.json()).code, 'INVALID_FROM_SEQ');

    const unknown = await fetch(`${app.base}/api/v3/zhouyi-bagua/messages/msg_nope/stream?from_seq=0`, {
      headers: { authorization: `Bearer ${tokenFor('acct-3c')}` },
    });
    assert.equal(unknown.status, 404);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 4) Quota
// ---------------------------------------------------------------------------
test('4) exhausting a limit yields the exact typed code and HTTP status', async () => {
  const app = await boot();
  try {
    // Anonymous deterministic path: 3 free calculations, then 403 ANON_CALC_LIMIT.
    const anon = { 'x-anon-id': 'client-quota' };
    for (let i = 1; i <= 3; i += 1) {
      const res = await postJson(app.base, '/api/bazi-calculate', { date: '2000-01-01', time: '12:00', timezone: 'UTC' }, anon);
      assert.equal(res.status, 200, `call ${i} should succeed`);
      assert.equal(res.body.facts.input.date, '2000-01-01');
    }
    const fourth = await postJson(app.base, '/api/bazi-calculate', { date: '2000-01-01', time: '12:00', timezone: 'UTC' }, anon);
    assertTypedError(fourth, 403, 'ANON_CALC_LIMIT');

    // Free signed-in user: the 2 trial charges, then AGENT_TRIAL_EXHAUSTED.
    const freeAuth = { authorization: `Bearer ${tokenFor('free-user')}` };
    const freeCodes = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await postJson(app.base, '/api/v3/zhouyi-bagua/messages', { content: 'x', conversation_id: 'c', archive_id: 'a', request_id: `f${i}` }, freeAuth);
      freeCodes.push(res.status);
    }
    assert.deepEqual(freeCodes, [200, 200, 403]);
    const exhausted = await postJson(app.base, '/api/v3/zhouyi-bagua/messages', { content: 'x', conversation_id: 'c', archive_id: 'a', request_id: 'f3' }, freeAuth);
    assertTypedError(exhausted, 403, 'AGENT_TRIAL_EXHAUSTED');
    // A free principal must never be told to "come back tomorrow".
    const freeAccess = await (await fetch(`${app.base}/api/access`, { headers: freeAuth })).json();
    assert.deepEqual(freeAccess.agentTrial, { limit: 2, used: 2, remaining: 0, hasRemaining: false });

    // Paying subscriber: 2 trial charges then 5 daily charges = 7, then 403.
    const auth = { authorization: `Bearer ${tokenFor('quota-user')}` };
    app.server.quota.setEntitlement('user:quota-user', { hasSubscription: true, accessEndDate: '2027-01-01' });
    const codes = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await postJson(app.base, '/api/v3/zhouyi-bagua/messages', { content: 'x', conversation_id: 'c', archive_id: 'a', request_id: `r${i}` }, auth);
      codes.push(res.status);
    }
    // 2 trial charges + 5 daily charges succeed, the 8th is refused.
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 200, 403]);
    const last = await postJson(app.base, '/api/v3/zhouyi-bagua/messages', { content: 'x', conversation_id: 'c', archive_id: 'a', request_id: 'r9' }, auth);
    assertTypedError(last, 403, 'DAILY_LIMIT_REACHED');

    // /api/access stays the authority and agrees with the refusals.
    const accessRes = await fetch(`${app.base}/api/access`, { headers: auth });
    const access = await accessRes.json();
    assert.equal(accessRes.status, 200);
    assert.deepEqual(access.agentTrial, { limit: 2, used: 2, remaining: 0, hasRemaining: false });
    assert.equal(access.hasSubscription, true);
    assert.equal(access.signInRequired, false);

    // A DIFFERENT principal is unaffected: the server decides, not a client cache.
    const fresh = await fetch(`${app.base}/api/access`, { headers: { authorization: `Bearer ${tokenFor('someone-else')}` } });
    assert.equal((await fresh.json()).agentTrial.hasRemaining, true);
  } finally {
    await app.close();
  }
});

test('4b) the kernel path is refused with a typed code, not a stack trace', async () => {
  const app = await boot();
  try {
    const res = await postJson(app.base, '/api/bazi-calculate', { date: 'not-a-date' }, { 'x-anon-id': 'c2' });
    assertTypedError(res, 400, 'INVALID_DATE');
    const lunar = await postJson(app.base, '/api/bazi-calculate', { date: '2000-01-01', calendar: 'lunar' }, { 'x-anon-id': 'c2' });
    assertTypedError(lunar, 400, 'INVALID_LUNAR_DATE');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 5) Tool schema validation over the wire
// ---------------------------------------------------------------------------
test('5) bad tool arguments never reach the handler and surface as a typed tool_result in the stream', async () => {
  // A registry whose tools have spy handlers. The narrator is given a tool plan
  // containing arguments a real model would plausibly get wrong, so the
  // assertion "the handler never ran" is observed at the HTTP boundary rather
  // than inferred from the validator's return value.
  const registry = new ToolRegistry();
  let dayInfoCalls = 0;
  let rangeCalls = 0;
  registry.register({
    name: 'almanac.day_info',
    description: 'spy tool: valid call',
    scopes: ['almanac'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['date'],
      properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
    },
    handler: () => {
      dayInfoCalls += 1;
      return { ok: true };
    },
  });
  registry.register({
    name: 'almanac.range_summary',
    description: 'spy tool: called here with a malformed date',
    scopes: ['almanac'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        bucket: { type: 'string', enum: ['day', 'month'] },
      },
    },
    handler: () => {
      rangeCalls += 1;
      return { ok: true };
    },
  });

  const toolPlan = [
    { name: 'almanac.day_info', arguments: { date: '2000-01-01' } },              // valid -> handler runs
    { name: 'almanac.range_summary', arguments: { from: '01/01/2000', to: '2000-02-01' } }, // pattern fails
    { name: 'almanac.range_summary', arguments: { from: '2000-01-01' } },         // required `to` missing
    { name: 'almanac.range_summary', arguments: { from: '2000-01-01', to: '2000-02-01', bucket: 'week' } }, // enum
  ];

  // Direct gate check first: a bad call returns a typed error and the handler is untouched.
  const direct = await registry.dispatch('almanac.range_summary', { from: 'nope', to: 'nope' }, { surface: 'almanac' });
  assert.equal(direct.ok, false);
  assert.equal(direct.error.code, 'INVALID_ARGUMENTS');
  assert.equal(rangeCalls, 0, 'validation gate let a bad call through');

  const offSurface = await registry.dispatch('almanac.day_info', { date: '2000-01-01' }, { surface: 'chart' });
  assert.equal(offSurface.error.code, 'TOOL_NOT_IN_SURFACE');
  assert.equal(dayInfoCalls, 0, 'an off-surface call must not run the handler either');

  // Now the same gate end-to-end, through a real agent stream.
  const app = await boot({ registry, toolPlan, frameDelayMs: 1 });
  try {
    const res = await fetch(`${app.base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('tool-user')}` },
      body: JSON.stringify({ message: 'go', timezone: 'UTC' }),
    });
    assert.equal(res.status, 200);
    const { frames } = await readNdjson(res);

    const calls = frames.filter((f) => f.type === 'tool_call');
    const results = frames.filter((f) => f.type === 'tool_result');
    assert.equal(calls.length, 4);
    // Index alignment survives failure: a rejected call is still a tool_result,
    // so the client's `toolCalls[index]` back-fill never drops it.
    assert.equal(results.length, 4);
    assert.deepEqual(results.map((r) => r.index), [0, 1, 2, 3]);

    assert.equal(results[0].result.ok, true);
    for (const [i, expectedKeyword] of [[1, 'pattern'], [2, 'required'], [3, 'enum']]) {
      assert.equal(results[i].result.ok, false, `result ${i} should have been rejected`);
      assert.equal(results[i].result.error.code, 'INVALID_ARGUMENTS');
      assert.ok(
        results[i].result.error.errors.some((e) => e.keyword === expectedKeyword),
        `result ${i}: expected keyword ${expectedKeyword}, got ${JSON.stringify(results[i].result.error.errors)}`,
      );
    }

    // The whole point: only the one valid call reached a handler.
    assert.equal(dayInfoCalls, 1);
    assert.equal(rangeCalls, 0, 'a handler ran despite invalid arguments');
  } finally {
    await app.close();
  }
});

test('5b) a malformed request body is a typed 400, not a crash', async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('acct-x')}` },
      body: '{"message": ',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_JSON');

    const missing = await postJson(app.base, '/api/agent/chat', { timezone: 'UTC' }, { authorization: `Bearer ${tokenFor('acct-x')}` });
    assertTypedError(missing, 400, 'MESSAGE_REQUIRED');

    const noRoute = await postJson(app.base, '/api/nope', {});
    assertTypedError(noRoute, 404, 'NOT_FOUND');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// E) Deterministic path
// ---------------------------------------------------------------------------
test('E) POST /api/bazi-calculate returns Facts + the narration prompt, deterministically and with no model call', async () => {
  const app = await boot();
  try {
    const body = { date: '1990-06-15', time: '08:30', timezone: 'Asia/Shanghai', gender: 'female' };
    const a = await postJson(app.base, '/api/bazi-calculate', body, { 'x-anon-id': 'kernel-1' });
    const b = await postJson(app.base, '/api/bazi-calculate', body, { 'x-anon-id': 'kernel-2' });

    assert.equal(a.status, 200);
    // Pure kernel: same input, same Facts, byte for byte.
    assert.deepEqual(a.body.facts, b.body.facts);
    assert.deepEqual(a.body.narrationPrompt, b.body.narrationPrompt);
    // Kernel-agnostic: the suite must pass with the real kernel (the default)
    // and with SHENSHA_KERNEL=stub, so assert the shape and the honesty rather
    // than a version string.
    assert.match(a.body.facts.kernelVersion, /^(stub|real)-/);
    assert.deepEqual(Object.keys(a.body.facts.fourPillars).sort(), ['day', 'hour', 'month', 'year']);
    assert.ok(a.body.facts.todos.length > 0, 'every kernel declares its own remaining gaps');

    // The narration block is the model's *only* input, and it is labelled as
    // authoritative so the model has no reason to re-derive anything.
    const prompt = a.body.narrationPrompt;
    assert.match(prompt, /FACTS \(authoritative, do not recompute\)/);
    for (const key of ['year', 'month', 'day', 'hour']) {
      assert.ok(prompt.includes(a.body.facts.fourPillars[key].ganzhi), `prompt must carry the resolved ${key} pillar`);
    }
    assert.match(prompt, /Do not compute, correct, or "fix" any value/);
  } finally {
    await app.close();
  }
});

test('E2) a payload larger than the body cap is refused with 413 rather than buffered without limit', async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.base}/api/bazi-calculate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-anon-id': 'big' },
      body: JSON.stringify({ date: '2000-01-01', pad: 'x'.repeat(300 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).code, 'PAYLOAD_TOO_LARGE');
  } finally {
    await app.close();
  }
});
