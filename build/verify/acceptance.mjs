/**
 * acceptance.mjs — INDEPENDENT acceptance test for build/skeleton.
 *
 * Deliberately does not import a single module from the skeleton:
 *  - the server is spawned as its own process (so the shipped entry point is exercised),
 *  - HTTP is real (loopback fetch),
 *  - NDJSON and SSE are parsed here, by hand, so a bug in the skeleton's own
 *    parsers cannot hide a bug in the skeleton's own encoders.
 *
 * Run:  "$NODE" build/verify/acceptance.mjs
 * Exits non-zero if any check fails.
 *
 * @module acceptance
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKELETON = path.resolve(HERE, '..', 'skeleton');
const SERVER = path.join(SKELETON, 'src', 'server.mjs');
const NODE = process.execPath;

// A fixed-but-unusual port keeps the spawn simple; the retry below handles the
// rare collision rather than picking a port and hoping.
const PORT = 20000 + (process.pid % 20000);
const ACCEPTANCE_SECRET = 'acceptance-harness-secret-0123456789';
const BASE = `http://127.0.0.1:${PORT}`;
/** Filled in after the server starts; minted over HTTP via the opt-in dev endpoint. */
let AUTH = null;

/** Independent-process token minting: HTTP, not an import of our own crypto. */
async function sessionToken(sub) {
  const res = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub }),
  });
  if (!res.ok) throw new Error(`could not mint a session for ${sub}: HTTP ${res.status}`);
  return (await res.json()).token;
}

const results = [];
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function startServer() {
  const child = spawn(NODE, [SERVER], {
    cwd: SKELETON,
    env: { ...process.env, PORT: String(PORT), frameDelayMs: '30', SHENSHA_SESSION_SECRET: ACCEPTANCE_SECRET, SHENSHA_ALLOW_DEV_SESSION: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 12_000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) { clearTimeout(timer); resolve(true); }
    });
    child.on('exit', (code) => { clearTimeout(timer); resolve(false); });
  });
  if (!ready) {
    console.error('server did not start. stderr:\n' + stderr);
    child.kill('SIGKILL');
    process.exit(2);
  }
  return child;
}

// ---------------------------------------------------------------------------
// Hand-rolled transport helpers (independent of src/frames.mjs)
// ---------------------------------------------------------------------------

async function getJson(pathname, headers = {}) {
  const res = await fetch(BASE + pathname, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, headers: res.headers, json, text };
}

async function postJson(pathname, body, headers = {}) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, headers: res.headers, json, text };
}

/** Reads an entire NDJSON response. */
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
  if (buf.trim()) frames.push(JSON.parse(buf.trim()));
  return frames;
}

/**
 * Reads an SSE response but stops early, simulating a client that dies
 * mid-answer. Returns the frames seen so far plus the response headers.
 * @param {Response} res
 * @param {number} stopAfter stop once this many frames have arrived
 */
async function readSsePartially(res, stopAfter) {
  const frames = [];
  let buf = '';
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  while (frames.length < stopAfter) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const parsed = parseSseBlock(block);
      if (parsed) frames.push(parsed);
      if (frames.length >= stopAfter) break;
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}

/** Reads an SSE response to completion. */
async function readSseFully(res) {
  const frames = [];
  let done = false;
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      if (block.includes('[DONE]')) { done = true; continue; }
      const parsed = parseSseBlock(block);
      if (parsed) frames.push(parsed);
    }
  }
  return { frames, sawDone: done };
}

/** @param {string} block @returns {object|null} */
function parseSseBlock(block) {
  const line = block.split('\n').find((l) => l.startsWith('data:'));
  if (!line) return null;
  const payload = line.replace(/^data:\s?/, '');
  if (payload === '[DONE]') return null;
  try { return JSON.parse(payload); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function main() {
  const child = await startServer();
  try {
    // Real signed session, minted over HTTP — the harness never imports our crypto.
    AUTH = { authorization: `Bearer ${await sessionToken('acceptance')}` };

    // --- 0. entitlement snapshot -----------------------------------------
    const access0 = await getJson('/api/access');
    check('GET /api/access returns a snapshot with agentTrial', access0.status === 200 && !!access0.json?.agentTrial,
      `status=${access0.status} trial=${JSON.stringify(access0.json?.agentTrial)}`);
    // Under the "agent needs a principal" policy the anonymous snapshot must NOT
    // advertise a usable trial — otherwise the client renders a composer the
    // server will always refuse (the coherence defect this harness exists to catch).
    check('anonymous snapshot does not advertise a usable agent trial',
      access0.json?.agentTrial?.hasRemaining === false,
      `hasRemaining=${access0.json?.agentTrial?.hasRemaining} signInRequired=${access0.json?.signInRequired}`);

    const authAccess = await getJson('/api/access', AUTH);
    const limit = authAccess.json?.agentTrial?.limit ?? 0;
    check('authenticated trial limit is a positive integer', Number.isInteger(limit) && limit > 0, `limit=${limit}`);

    // --- 1. deterministic kernel path (no model) -------------------------
    const calcOk = await postJson('/api/bazi-calculate', { date: '1990-05-17', time: '08:30', timezone: 'Asia/Shanghai' });
    const pillars = calcOk.json?.facts?.fourPillars;
    check('POST /api/bazi-calculate returns Facts with four pillars',
      calcOk.status === 200 && pillars && ['year', 'month', 'day', 'hour'].every((p) => pillars[p]?.ganzhi),
      `status=${calcOk.status} pillars=${pillars ? Object.keys(pillars).join(',') : 'none'}`);
    check('kernel response includes the narration prompt block it would hand the model',
      typeof calcOk.json?.narrationPrompt === 'string' && calcOk.json.narrationPrompt.includes('FACTS'),
      `promptBytes=${calcOk.json?.narrationPrompt?.length ?? 0}`);

    const calcBad = await postJson('/api/bazi-calculate', { date: '1990-13-40' });
    check('bad date is a typed 4xx, not a crash',
      calcBad.status >= 400 && calcBad.status < 500 && typeof calcBad.json?.code === 'string',
      `status=${calcBad.status} code=${calcBad.json?.code}`);

    // --- 1b. structured birth (PROTOCOL.md §4bis) -----------------------
    // Two rules under test: structured birth is authoritative (never a date
    // guessed from prose), and a malformed birth block costs the user nothing.
    const tok = {
      ok: await sessionToken('birth-ok'),
      bad1: await sessionToken('birth-bad1'),
      bad2: await sessionToken('birth-bad2'),
      demo: await sessionToken('birth-demo'),
    };
    const birthTok = (n) => ({ authorization: `Bearer ${tok[n]}` });
    const goodBirth = { date: '1990-05-17', time: '08:30', timezone: 'Asia/Shanghai' };

    const good = await fetch(BASE + '/api/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...birthTok('ok') },
      body: JSON.stringify({ message: '帮我看一下', birth: goodBirth }),
    });
    const goodText = await good.text();
    check('structured birth is authoritative (x-chart-source: birth, chart echoes it)',
      good.status === 200 && good.headers.get('x-chart-source') === 'birth' && goodText.includes('1990-05-17'),
      `status=${good.status} source=${good.headers.get('x-chart-source')} echoesDate=${goodText.includes('1990-05-17')}`);

    const incomplete = await postJson('/api/agent/chat', { message: 'x', birth: { date: '1990-05-17' } }, birthTok('bad1'));
    const afterIncomplete = await getJson('/api/access', birthTok('bad1'));
    check('incomplete birth is a typed 400 that costs no quota',
      incomplete.status === 400 && incomplete.json?.code === 'INCOMPLETE_INFORMATION'
      && Array.isArray(incomplete.json?.missing)
      && (afterIncomplete.json?.agentTrial?.used ?? 0) === 0,
      `status=${incomplete.status} code=${incomplete.json?.code} missing=${JSON.stringify(incomplete.json?.missing)} used=${afterIncomplete.json?.agentTrial?.used}`);

    const badZone = await postJson('/api/agent/chat', { message: 'x', birth: { ...goodBirth, timezone: 'Not/AZone' } }, birthTok('bad2'));
    const afterBadZone = await getJson('/api/access', birthTok('bad2'));
    check('unknown IANA timezone is rejected (INVALID_TIMEZONE) and costs no quota',
      badZone.status === 400 && badZone.json?.code === 'INVALID_TIMEZONE'
      && (afterBadZone.json?.agentTrial?.used ?? 0) === 0,
      `status=${badZone.status} code=${badZone.json?.code} used=${afterBadZone.json?.agentTrial?.used}`);

    const noBirth = await fetch(BASE + '/api/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...birthTok('demo') },
      body: JSON.stringify({ message: '随便聊聊 1990-05-17' }),
    });
    await noBirth.text();
    check('a chart request without birth is explicitly marked as a placeholder',
      noBirth.status === 200 && noBirth.headers.get('x-chart-source') === 'placeholder',
      `source=${noBirth.headers.get('x-chart-source')}`);

    // --- 2. agent NDJSON stream (authenticated: this checks frame ordering) ---
    // Coherence first, and policy-independently: whatever the product decides
    // about anonymous agent use, the snapshot and the request must AGREE. Being
    // told "2 uses remaining" and then refused is the defect; either policy is fine.
    const anonProbe = await fetch(BASE + '/api/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '你好' }),
    });
    const anonTrial = access0.json?.agentTrial;
    const anonRefused = anonProbe.status >= 400;
    let anonBody = null;
    try { anonBody = JSON.parse(await anonProbe.text()); } catch { /* stream or empty */ }
    check('anonymous agent call is COHERENT with the anonymous access snapshot',
      (anonTrial?.hasRemaining === true && anonProbe.status === 200)
      || (anonTrial?.hasRemaining === false && anonRefused && typeof anonBody?.code === 'string'),
      `snapshot.hasRemaining=${anonTrial?.hasRemaining} status=${anonProbe.status} code=${anonBody?.code}`);

    // The same condition must get the same answer on every agent surface:
    // the SSE route already answers "no credentials" with 401.
    if (anonRefused) {
      check('anonymous agent refusal uses the same status as the SSE agent route (401)',
        anonProbe.status === 401, `ndjson=${anonProbe.status}`);
    }

    const agentRes = await fetch(BASE + '/api/agent/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ conversationId: null, message: '你好，帮我看一下 1990-05-17', timezone: 'Asia/Shanghai', language: 'zh' }),
    });
    check('agent stream uses content-type text/plain (NDJSON contract)', /text\/plain/.test(agentRes.headers.get('content-type') ?? ''),
      `content-type=${agentRes.headers.get('content-type')}`);
    const agentFrames = await readNdjson(agentRes);
    const kinds = agentFrames.map((f) => f.type);
    const idx = (k) => kinds.indexOf(k);
    check('agent stream opens with conversation_id', idx('conversation_id') === 0, `kinds=${kinds.slice(0, 6).join(',')}`);
    check('agent stream carries reasoning before phase_change before content',
      idx('reasoning') >= 0 && idx('phase_change') > idx('reasoning') && idx('content') > idx('phase_change'),
      `reasoning=${idx('reasoning')} phase=${idx('phase_change')} content=${idx('content')}`);
    check('agent stream has no error frame', idx('error') === -1, `kinds=${[...new Set(kinds)].join(',')}`);

    // --- 3. chat SSE + resume invariant (the whole point) ---------------
    const chatRes = await fetch(`${BASE}/api/v3/demo/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ content: '1990-05-17 今天适合做什么', conversation_id: 'conv-acceptance', archive_id: 'arch-1', request_id: 'req-acceptance-1' }),
    });
    check('chat stream uses content-type text/event-stream', /text\/event-stream/.test(chatRes.headers.get('content-type') ?? ''),
      `content-type=${chatRes.headers.get('content-type')}`);
    const messageId = chatRes.headers.get('x-message-id');
    check('chat stream exposes x-message-id before frame 1 (resumable identity)', typeof messageId === 'string' && messageId.length > 0,
      `x-message-id=${messageId}`);

    const firstLeg = await readSsePartially(chatRes, 3);
    const firstSeqs = firstLeg.map((f) => f.seq);
    check('first leg received >=3 frames with monotonic seq',
      firstSeqs.length >= 3 && firstSeqs.every((s, i) => i === 0 || s > firstSeqs[i - 1]),
      `seqs=${firstSeqs.join(',')}`);

    // Simulate the reconnect the client would do after the socket died.
    await sleep(150);
    const resumeRes = await fetch(`${BASE}/api/v3/demo/messages/${messageId}/stream?from_seq=${firstSeqs.at(-1)}`, { headers: AUTH });
    const secondLeg = await readSseFully(resumeRes);
    const secondSeqs = secondLeg.frames.map((f) => f.seq);

    check('resume returns ONLY frames with seq > from_seq',
      secondSeqs.every((s) => s > firstSeqs.at(-1)),
      `from=${firstSeqs.at(-1)} resumed=${secondSeqs.slice(0, 8).join(',')}${secondSeqs.length > 8 ? ',…' : ''}`);
    check('resume starts exactly at from_seq + 1 (no gap)',
      secondSeqs.length === 0 || secondSeqs[0] === firstSeqs.at(-1) + 1,
      `expected=${firstSeqs.at(-1) + 1} got=${secondSeqs[0]}`);
    check('resume is strictly increasing (no duplicate, no reordering)',
      secondSeqs.every((s, i) => i === 0 || s === secondSeqs[i - 1] + 1),
      `seqs=${secondSeqs.join(',')}`);
    const union = [...firstSeqs, ...secondSeqs];
    check('the two legs are disjoint (a frame is never delivered twice)',
      new Set(union).size === union.length, `count=${union.length} unique=${new Set(union).size}`);
    const terminal = secondLeg.frames.at(-1);
    check('resume ends with a terminal frame (end or error)',
      terminal && ['end', 'error'].includes(terminal.msg?.event),
      `lastEvent=${terminal?.msg?.event}`);
    check('stream terminated with the [DONE] sentinel',
      secondLeg.sawDone || secondLeg.frames.length === 0,
      `sawDone=${secondLeg.sawDone}`);

    // --- 4. idempotent billing on request_id ---------------------------
    const accessBefore = await getJson('/api/access', AUTH);
    const usedBefore = accessBefore.json?.agentTrial?.used ?? 0;
    const replayRes = await fetch(`${BASE}/api/v3/demo/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ content: 'repeat of the same logical request', conversation_id: 'conv-acceptance', archive_id: 'arch-1', request_id: 'req-acceptance-1' }),
    });
    const replayMessageId = replayRes.headers.get('x-message-id');
    await replayRes.body?.cancel?.().catch(() => {});
    const accessAfter = await getJson('/api/access', AUTH);
    const usedAfter = accessAfter.json?.agentTrial?.used ?? 0;
    check('replaying the same request_id does NOT create a second message',
      replayMessageId === messageId, `first=${messageId} replay=${replayMessageId}`);
    check('replaying the same request_id does NOT charge twice',
      usedAfter === usedBefore, `used ${usedBefore} -> ${usedAfter}`);

    // --- 5. quota exhaustion contract (authenticated principal) --------
    let lastStatus = 0;
    let lastCode = '';
    for (let i = 0; i < limit + 3; i += 1) {
      const r = await postJson('/api/agent/chat', { message: `exhaust ${i}` }, AUTH);
      lastStatus = r.status;
      lastCode = r.json?.code ?? '';
      if (r.status >= 400) break;
    }
    check('exhausted agent quota returns a typed code, not a bare failure',
      lastStatus === 403 && typeof lastCode === 'string' && lastCode.length > 0,
      `status=${lastStatus} code=${lastCode}`);
    // Precedence matters here: a free principal with no entitlement must be told
    // "trial exhausted" (upsell), NOT "daily limit reached" — the latter promises
    // a budget that never returns. This exact bug existed once; pin it.
    check('trial exhaustion reports AGENT_TRIAL_EXHAUSTED, not DAILY_LIMIT_REACHED',
      lastCode === 'AGENT_TRIAL_EXHAUSTED', `code=${lastCode}`);
    const accessExhausted = await getJson('/api/access', AUTH);
    check('access snapshot reflects exhaustion (hasRemaining false)',
      accessExhausted.json?.agentTrial?.hasRemaining === false,
      JSON.stringify(accessExhausted.json?.agentTrial));

    // --- 6. auth boundary ----------------------------------------------
    const unauth = await fetch(`${BASE}/api/v3/demo/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'no auth' }),
    });
    const unauthBody = await unauth.json().catch(() => null);
    check('chat stream without credentials is 401 (sign-in), not 403 (quota)',
      unauth.status === 401, `status=${unauth.status} code=${unauthBody?.code}`);
  } finally {
    child.kill('SIGTERM');
    await sleep(150);
    if (!child.killed) child.kill('SIGKILL');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name} (${f.detail})`);
    process.exit(1);
  }
  console.log('ACCEPTANCE: PASS');
}

main().catch((err) => {
  console.error('harness error:', err);
  process.exit(3);
});
