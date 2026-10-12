/**
 * birth.test.mjs — structured birth input (PROTOCOL.md §4bis).
 *
 * The two rules worth a regression test:
 *
 *  1. Structured `birth` is authoritative, and a request WITHOUT it is explicitly
 *     marked as a demo placeholder — never a date silently guessed from prose.
 *  2. A malformed `birth` block is a typed 400 that costs the user NOTHING. If
 *     validation ran after the charge, a user with a typo would pay for the
 *     privilege of being told they made a typo.
 *
 * @module test/birth
 */

import { test } from 'node:test';
import { tokenFor, TEST_SECRET, bearer } from './helpers.mjs';
import assert from 'node:assert/strict';

import { listen } from '../src/server.mjs';

/** Boots a real server on an ephemeral port. */
async function boot(opts = {}) {
  const { server, baseUrl } = await listen({ sessionSecret: TEST_SECRET, ...opts });
  return { baseUrl, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** @returns {Promise<{status:number, headers:Headers, json:any, text:string}>} */
async function post(baseUrl, path, body, headers = {}) {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* NDJSON or SSE: leave null */ }
  return { status: res.status, headers: res.headers, json, text };
}

/** Quota already spent by one principal — read from the server, never assumed. */
async function used(baseUrl, token) {
  const res = await fetch(`${baseUrl}/api/access`, { headers: { authorization: `Bearer ${tokenFor(token)}` } });
  return (await res.json()).agentTrial.used;
}

/**
 * The assistant text as the CLIENT would assemble it.
 *
 * Asserting on the raw NDJSON body is a trap: content is emitted in 24-character
 * chunks, so any phrase can straddle two frames and vanish from a substring
 * search on the wire while being perfectly present in the answer. Join first.
 * @param {string} ndjson
 */
function assembledText(ndjson) {
  return ndjson.split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((f) => f && f.type === 'content')
    .map((f) => f.content)
    .join('');
}

const GOOD = Object.freeze({ date: '1990-05-17', time: '08:30', timezone: 'Asia/Shanghai' });

test('structured birth is authoritative and echoed by the chart', async () => {
  const app = await boot({ frameDelayMs: 0 });
  try {
    const res = await post(app.baseUrl, '/api/agent/chat', { message: '帮我看一下', birth: GOOD }, { authorization: `Bearer ${tokenFor('b-ok')}` });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-chart-source'), 'birth');
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    // The narrated prose must quote the birth the client sent, not a regex guess.
    assert.ok(assembledText(res.text).includes('1990-05-17'), 'narration should carry the structured birth date');
  } finally {
    await app.close();
  }
});

test('a request without birth is explicitly a placeholder, never a guessed chart', async () => {
  const app = await boot({ frameDelayMs: 0 });
  try {
    const res = await post(app.baseUrl, '/api/agent/chat', { message: '随便聊聊 1990-05-17' }, { authorization: `Bearer ${tokenFor('b-demo')}` });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-chart-source'), 'placeholder');
    assert.ok(assembledText(res.text).includes('DEMO placeholder'), 'the facts must carry an explicit placeholder warning');
  } finally {
    await app.close();
  }
});

test('incomplete birth is 400 INCOMPLETE_INFORMATION listing the missing fields', async () => {
  const app = await boot({ frameDelayMs: 0 });
  try {
    const res = await post(app.baseUrl, '/api/agent/chat', { message: 'x', birth: { date: '1990-05-17' } }, { authorization: `Bearer ${tokenFor('b-inc')}` });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'INCOMPLETE_INFORMATION');
    assert.ok(Array.isArray(res.json.missing) && res.json.missing.includes('timezone'));
  } finally {
    await app.close();
  }
});

test('unknown birth time is refused rather than silently defaulted', async () => {
  const app = await boot({ frameDelayMs: 0 });
  try {
    const res = await post(app.baseUrl, '/api/agent/chat', { message: 'x', birth: { ...GOOD, time: null } }, { authorization: `Bearer ${tokenFor('b-nulltime')}` });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'BIRTH_TIME_REQUIRED');
  } finally {
    await app.close();
  }
});

test('an unknown IANA timezone is rejected (it decides every boundary)', async () => {
  const app = await boot({ frameDelayMs: 0 });
  try {
    const res = await post(app.baseUrl, '/api/agent/chat', { message: 'x', birth: { ...GOOD, timezone: 'Not/AZone' } }, { authorization: `Bearer ${tokenFor('b-zone')}` });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'INVALID_TIMEZONE');
  } finally {
    await app.close();
  }
});

test('malformed input never costs quota, on either agent route', async () => {
  const app = await boot({ frameDelayMs: 0 });
  try {
    const cases = [
      ['incomplete', { date: '1990-05-17' }, 'INCOMPLETE_INFORMATION'],
      ['unknown time', { ...GOOD, time: null }, 'BIRTH_TIME_REQUIRED'],
      ['bad date', { ...GOOD, date: 'nonsense' }, 'INVALID_DATE'],
      ['bad zone', { ...GOOD, timezone: 'Not/AZone' }, 'INVALID_TIMEZONE'],
    ];
    for (const [label, birth, code] of cases) {
      // The header carries its own prefix here, so mint the token for the label.
      const token = `Bearer ${tokenFor(`q-${label.replace(/\s+/g, '')}`)}`;
      const before = await used(app.baseUrl, token);
      const ndjson = await post(app.baseUrl, '/api/agent/chat', { message: 'x', birth }, { authorization: token });
      assert.equal(ndjson.status, 400, `${label}: NDJSON route status`);
      assert.equal(ndjson.json.code, code, `${label}: code`);

      const sse = await post(app.baseUrl, '/api/v3/zhouyi-bagua/messages', { content: 'x', request_id: `r-${label}`, birth }, { authorization: token });
      assert.equal(sse.status, 400, `${label}: SSE route status (must fail before any frame)`);

      assert.equal(await used(app.baseUrl, token), before, `${label}: quota must not move`);
    }
  } finally {
    await app.close();
  }
});

test('the SSE route honours structured birth and marks the chart source', async () => {
  const app = await boot({ frameDelayMs: 0 });
  try {
    const res = await post(app.baseUrl, '/api/v3/zhouyi-bagua/messages', { content: 'x', request_id: 'sse-birth', birth: GOOD }, { authorization: `Bearer ${tokenFor('sse-birth')}` });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-chart-source'), 'birth');
    // The helper already drained the stream; assert on the frames it captured.
    assert.match(res.text, /"event":"start"/);
    assert.ok(res.text.includes('[DONE]'), 'SSE stream should terminate with the sentinel');
  } finally {
    await app.close();
  }
});
