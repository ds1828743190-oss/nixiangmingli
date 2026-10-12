/**
 * session.test.mjs — the security properties of signed sessions.
 *
 * These tests exist because the code they replace accepted ANY non-empty bearer
 * as an identity. That is not a small hole: every ownership check in the product
 * (stream resume, request_id idempotency, quota ledger) is only as strong as the
 * identity it compares against, so "the header is not verified" makes all of them
 * decorative at once.
 *
 * Each forgery gets its own case, and each must fail for the RIGHT reason.
 *
 * @module test/session
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { createSessionVerifier, SESSION_ERROR } from '../src/session.mjs';
import { boot, tokenFor, TEST_SECRET } from './helpers.mjs';

const SECRET = TEST_SECRET;
const OTHER = 'a-different-secret-0123456789abcd';

/** Signs a payload exactly the way session.mjs does, so a forgery is "validly" signed. */
const signRaw = (payloadB64, secret) => createHmac('sha256', Buffer.from(secret)).update(`v1.${payloadB64}`).digest('base64url');

test('a minted token verifies and carries its subject', () => {
  const v = createSessionVerifier({ secret: SECRET });
  const token = v.mint({ sub: 'user-7', ttlSeconds: 60 });
  const verdict = v.verify(token);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.sub, 'user-7');
  assert.ok(verdict.exp > Math.floor(Date.now() / 1000));
});

test('a tampered payload is rejected by the signature', () => {
  const v = createSessionVerifier({ secret: SECRET });
  const token = v.mint({ sub: 'user-7' });
  const [version, payload, sig] = token.split('.');
  // Re-encode the payload with a different subject, keeping the original signature.
  const forgedPayload = Buffer.from(JSON.stringify({ sub: 'admin', iat: 0, exp: 9999999999 })).toString('base64url');
  const forged = `${version}.${forgedPayload}.${sig}`;
  assert.notEqual(payload, forgedPayload); // guard: the test must actually change something
  assert.deepEqual(v.verify(forged), { ok: false, code: SESSION_ERROR.BAD_SIGNATURE });
});

test('a token signed with a different key is rejected', () => {
  const mine = createSessionVerifier({ secret: SECRET });
  const theirs = createSessionVerifier({ secret: OTHER });
  assert.deepEqual(mine.verify(theirs.mint({ sub: 'attacker' })), { ok: false, code: SESSION_ERROR.BAD_SIGNATURE });
});

test('an ephemeral verifier does not accept another ephemeral verifier\'s tokens', () => {
  const a = createSessionVerifier();
  const b = createSessionVerifier();
  assert.equal(a.ephemeral, true);
  assert.equal(b.ephemeral, true);
  assert.equal(b.verify(a.mint({ sub: 'x' })).ok, false);
});

test('an expired token is rejected as expired, not as malformed', () => {
  const v = createSessionVerifier({ secret: SECRET });
  const now = Date.now();
  const token = v.mint({ sub: 'user-7', ttlSeconds: 60, now });
  assert.equal(v.verify(token, now + 30_000).ok, true, 'still valid inside the window');
  assert.deepEqual(v.verify(token, now + 61_000), { ok: false, code: SESSION_ERROR.EXPIRED });
});

test('a correctly-signed token with no expiry is refused, not treated as immortal', () => {
  const v = createSessionVerifier({ secret: SECRET });
  const payloadB64 = Buffer.from(JSON.stringify({ sub: 'user-7' })).toString('base64url');
  const token = `v1.${payloadB64}.${signRaw(payloadB64, SECRET)}`; // signature IS valid
  assert.equal(v.verify(token).ok, false, 'only an explicit exp check can stop this');
  assert.deepEqual(v.verify(token), { ok: false, code: SESSION_ERROR.MALFORMED });
});

test('a correctly-signed token with an empty subject is refused', () => {
  const v = createSessionVerifier({ secret: SECRET });
  const payloadB64 = Buffer.from(JSON.stringify({ sub: '  ', exp: 9999999999 })).toString('base64url');
  const token = `v1.${payloadB64}.${signRaw(payloadB64, SECRET)}`;
  assert.deepEqual(v.verify(token), { ok: false, code: SESSION_ERROR.NO_SUBJECT });
});

test('malformed and unsupported tokens are typed failures, never throws', () => {
  const v = createSessionVerifier({ secret: SECRET });
  for (const bad of ['', 'garbage', 'v1.only-two', 'v1...', 'v1.!!!.###', 'v2.abc.def']) {
    const verdict = v.verify(bad);
    assert.equal(verdict.ok, false, `expected ${JSON.stringify(bad)} to fail`);
    assert.ok(Object.values(SESSION_ERROR).includes(verdict.code), `unexpected code for ${JSON.stringify(bad)}`);
  }
});

test('a short secret is refused at construction', () => {
  assert.throws(() => createSessionVerifier({ secret: 'too-short' }), /at least 16 bytes/);
});

test('minting requires a subject', () => {
  const v = createSessionVerifier({ secret: SECRET });
  assert.throws(() => v.mint({ sub: '   ' }), /subject/);
});

// ---------------------------------------------------------------------------
// Through the HTTP surface
// ---------------------------------------------------------------------------

test('an unsigned bearer no longer authenticates anywhere', async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.baseUrl}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer whatever-i-want' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 401, 'the forged token must not sign anyone in');
    const body = await res.json();
    assert.equal(body.code, SESSION_ERROR.MALFORMED);
  } finally {
    await app.close();
  }
});

test('a minted token authenticates, and an expired one says why', async () => {
  const app = await boot();
  try {
    const ok = await fetch(`${app.baseUrl}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('acct-1')}` },
      body: JSON.stringify({ message: 'hi', birth: { date: '2000-01-01', time: '12:00', timezone: 'Asia/Shanghai' } }),
    });
    assert.equal(ok.status, 200);
    await ok.text();

    const expired = tokenFor('acct-2', { ttlSeconds: -1 });
    const res = await fetch(`${app.baseUrl}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${expired}` },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, SESSION_ERROR.EXPIRED, 'expired must be distinguishable from malformed');
  } finally {
    await app.close();
  }
});

test('the dev mint endpoint is absent unless explicitly enabled', async () => {
  const off = await boot();
  try {
    const res = await fetch(`${off.baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: 'x' }),
    });
    // 404 rather than 403: a probe should not learn the route exists at all.
    assert.equal(res.status, 404);
  } finally {
    await off.close();
  }

  const on = await boot({ allowDevSessions: true });
  try {
    const res = await fetch(`${on.baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: 'dev-user' }),
    });
    assert.equal(res.status, 200);
    const { token, tokenType } = await res.json();
    assert.equal(tokenType, 'Bearer');
    // …and the token it hands out really works.
    const chat = await fetch(`${on.baseUrl}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: 'hi', birth: { date: '2000-01-01', time: '12:00', timezone: 'Asia/Shanghai' } }),
    });
    assert.equal(chat.status, 200);
    await chat.text();
  } finally {
    await on.close();
  }
});

test('an anonymous caller still works (the free hook survives authentication)', async () => {
  const app = await boot();
  try {
    const res = await fetch(`${app.baseUrl}/api/bazi-calculate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-anon-id': 'anon-visitor' },
      body: JSON.stringify({ date: '2000-01-01', time: '12:00', timezone: 'Asia/Shanghai' }),
    });
    assert.equal(res.status, 200, 'requiring sessions must not break the anonymous deterministic path');
  } finally {
    await app.close();
  }
});
