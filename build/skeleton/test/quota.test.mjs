/**
 * quota.test.mjs — server-authoritative entitlement with typed codes.
 *
 * The behaviour worth pinning down: `check()` is a pure predicate that can be
 * called as often as the UI likes (page load, focus, submit) without spending
 * anything, and only `consume()` charges. If a refactor ever makes `check()`
 * mutate, the client's optimistic pre-check silently becomes the authority —
 * which is exactly the bug this module exists to prevent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EntitlementStore, QuotaError, QUOTA_ERROR, LIMITS, KIND, dayKey, resolvePrincipal } from '../src/quota.mjs';
import { createSessionVerifier } from '../src/session.mjs';
import { TEST_SECRET } from './helpers.mjs';

const ANON = 'anon:client-1';
const USER = 'user:acct-1';

test('defaults match the contract: anon 3, daily 5, agent trial 2', () => {
  assert.deepEqual(LIMITS, { anonCalcLimit: 3, dailyAnalysisLimit: 5, agentTrialLimit: 2 });
  const store = new EntitlementStore();
  assert.deepEqual(store.ledger(USER), {
    anonymous: false,
    anonCalcUsed: 0,
    anonCalcLimit: 3,
    agentTrialUsed: 0,
    agentTrialLimit: 2,
    dailyUsed: 0,
    dailyLimit: 5,
    dailyKey: dayKey(store.now(), 'UTC'),
  });
});

test('check() never consumes, no matter how often it is called', () => {
  const store = new EntitlementStore();
  for (let i = 0; i < 10; i += 1) assert.equal(store.check(ANON, KIND.CALC).allowed, true);
  assert.equal(store.ledger(ANON).anonCalcUsed, 0);
});

test('anonymous calculation stops at exactly 3 with ANON_CALC_LIMIT', () => {
  const store = new EntitlementStore();
  for (let i = 0; i < 3; i += 1) store.consume(ANON, KIND.CALC, { messageId: `m${i}` });
  assert.equal(store.check(ANON, KIND.CALC).allowed, false);
  assert.equal(store.check(ANON, KIND.CALC).code, 'ANON_CALC_LIMIT');
  assert.equal(QUOTA_ERROR.ANON_CALC_LIMIT.status, 403);
  assert.throws(
    () => store.consume(ANON, KIND.CALC),
    (err) => err instanceof QuotaError && err.code === 'ANON_CALC_LIMIT' && err.status === 403,
  );
});

test('anonymous users cannot use the model-backed agent at all (ANON_LIMIT_REACHED)', () => {
  const store = new EntitlementStore();
  const verdict = store.check(ANON, KIND.AGENT);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'ANON_LIMIT_REACHED');
  assert.equal(QUOTA_ERROR.ANON_LIMIT_REACHED.status, 403);
});

test('a free user spends the trial, then gets AGENT_TRIAL_EXHAUSTED — not a daily-limit message', () => {
  const store = new EntitlementStore();
  store.consume(USER, KIND.AGENT, { messageId: 'm1' });
  store.consume(USER, KIND.AGENT, { messageId: 'm2' });
  const ledger = store.ledger(USER);
  assert.equal(ledger.agentTrialUsed, 2, 'trial is spent first');
  assert.equal(ledger.dailyUsed, 0, 'a free user never reaches the daily bucket');

  const verdict = store.check(USER, KIND.AGENT);
  assert.equal(verdict.allowed, false);
  // The distinction matters commercially: "come back tomorrow" is wrong advice
  // for a budget that will never refill without a purchase.
  assert.equal(verdict.code, 'AGENT_TRIAL_EXHAUSTED');
  assert.equal(QUOTA_ERROR.AGENT_TRIAL_EXHAUSTED.status, 403);
  assert.throws(() => store.consume(USER, KIND.AGENT), (err) => err.code === 'AGENT_TRIAL_EXHAUSTED' && err.status === 403);
});

test('a subscriber spends the trial first, then the daily allowance, then gets DAILY_LIMIT_REACHED', () => {
  const store = new EntitlementStore();
  store.setEntitlement(USER, { hasSubscription: true, accessEndDate: '2027-01-01', remainingTime: 'P89D' });

  store.consume(USER, KIND.AGENT, { messageId: 'm1' });
  store.consume(USER, KIND.AGENT, { messageId: 'm2' });
  assert.equal(store.ledger(USER).agentTrialUsed, 2, 'trial exhausted first');
  assert.equal(store.ledger(USER).dailyUsed, 0);

  // Third onward falls through to the daily allowance.
  for (const id of ['m3', 'm4']) store.consume(USER, KIND.AGENT, { messageId: id });
  assert.equal(store.ledger(USER).agentTrialUsed, 2);
  assert.equal(store.ledger(USER).dailyUsed, 2);

  store.consume(USER, KIND.AGENT, { messageId: 'm5' });
  assert.equal(store.check(USER, KIND.AGENT).allowed, true, 'daily limit is 5, so 3 used is still fine');

  store.consume(USER, KIND.AGENT, { messageId: 'm6' });
  store.consume(USER, KIND.AGENT, { messageId: 'm7' });
  assert.equal(store.ledger(USER).dailyUsed, 5);
  const exhausted = store.check(USER, KIND.AGENT);
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.code, 'DAILY_LIMIT_REACHED');
  assert.equal(QUOTA_ERROR.DAILY_LIMIT_REACHED.status, 403);
});

test('every typed code carries the contracted HTTP status', () => {
  assert.equal(QUOTA_ERROR.ANON_CALC_LIMIT.status, 403);
  assert.equal(QUOTA_ERROR.ANON_LIMIT_REACHED.status, 403);
  assert.equal(QUOTA_ERROR.DAILY_LIMIT_REACHED.status, 403);
  assert.equal(QUOTA_ERROR.AGENT_TRIAL_EXHAUSTED.status, 403);
  assert.equal(QUOTA_ERROR.INTERNAL_SERVER_ERROR.status, 500);
  const err = new QuotaError('AGENT_TRIAL_EXHAUSTED', 'detail');
  assert.deepEqual(err.toBody(), {
    code: 'AGENT_TRIAL_EXHAUSTED',
    message: QUOTA_ERROR.AGENT_TRIAL_EXHAUSTED.message,
    status: 403,
  });
});

test('accessSnapshot has the contracted fields and a self-consistent hasRemaining', () => {
  const store = new EntitlementStore();
  const before = store.accessSnapshot(USER);
  assert.deepEqual(Object.keys(before).sort(), [
    'accessEndDate', 'accessType', 'agentTrial', 'hasPurchase', 'hasSubscription', 'remainingTime', 'signInRequired',
  ]);
  assert.deepEqual(Object.keys(before.agentTrial).sort(), ['hasRemaining', 'limit', 'remaining', 'used']);
  assert.deepEqual(before.agentTrial, { limit: 2, used: 0, remaining: 2, hasRemaining: true });

  store.consume(USER, KIND.AGENT);
  store.consume(USER, KIND.AGENT);
  const after = store.accessSnapshot(USER);
  assert.deepEqual(after.agentTrial, { limit: 2, used: 2, remaining: 0, hasRemaining: false });
});

test('the daily ledger rolls over at local midnight, evaluated on read', () => {
  let now = new Date('2026-10-12T23:59:00Z');
  const store = new EntitlementStore({ now: () => now });
  // The daily bucket belongs to paying users; a free principal stops at trial.
  store.setEntitlement(USER, { hasSubscription: true });
  for (let i = 0; i < 5; i += 1) store.consume(USER, KIND.AGENT); // 2 trial + 3 daily
  assert.equal(store.check(USER, KIND.AGENT).allowed, true);
  store.consume(USER, KIND.AGENT);
  store.consume(USER, KIND.AGENT);
  assert.equal(store.check(USER, KIND.AGENT).allowed, false);

  now = new Date('2026-10-13T00:01:00Z'); // next day
  assert.equal(store.check(USER, KIND.AGENT).allowed, true, 'daily resets; trial does not come back');
  assert.equal(store.ledger(USER).dailyUsed, 0);
  assert.equal(store.ledger(USER).agentTrialUsed, 2, 'a trial is a one-time budget, not a daily one');
  assert.equal(store.check('user:never-paid', KIND.AGENT).allowed, true, 'a fresh principal still has its trial');

  // And a free principal that never had an entitlement still stops at trial.
  const free = new EntitlementStore({ now: () => new Date('2026-10-13T00:01:00Z') });
  free.consume('user:free', KIND.AGENT);
  free.consume('user:free', KIND.AGENT);
  assert.equal(free.check('user:free', KIND.AGENT).code, 'AGENT_TRIAL_EXHAUSTED');
});

test('two principals never share a budget', () => {
  const store = new EntitlementStore();
  for (let i = 0; i < 3; i += 1) store.consume(ANON, KIND.CALC);
  assert.equal(store.check(ANON, KIND.CALC).allowed, false);
  assert.equal(store.check('anon:client-2', KIND.CALC).allowed, true);
});

test('resolvePrincipal grants identity ONLY for a token that verifies', () => {
  const verifier = createSessionVerifier({ secret: TEST_SECRET });
  const withAuth = { headers: { authorization: `Bearer ${verifier.mint({ sub: 'user-9' })}`, 'x-anon-id': 'client-9' } };
  assert.deepEqual(resolvePrincipal(withAuth, verifier), { principalId: 'user:user-9', anonymous: false });

  // The hole this replaced: an arbitrary string used to become `user:<string>`.
  // Now an unverifiable token is not a weaker identity — it is NO identity.
  const forged = { headers: { authorization: 'Bearer tok-123', 'x-anon-id': 'client-9' } };
  const forgedVerdict = resolvePrincipal(forged, verifier);
  assert.equal(forgedVerdict.anonymous, true, 'an unsigned bearer must not authenticate');
  assert.equal(forgedVerdict.principalId, 'anon:client-9');
  assert.equal(forgedVerdict.sessionError, 'SESSION_MALFORMED');

  // A token signed with a different key is refused, and the reason is specific.
  const otherKey = createSessionVerifier({ secret: 'another-secret-0123456789abcdef' });
  const foreign = { headers: { authorization: `Bearer ${otherKey.mint({ sub: 'attacker' })}` } };
  const foreignVerdict = resolvePrincipal(foreign, verifier);
  assert.equal(foreignVerdict.anonymous, true);
  assert.equal(foreignVerdict.sessionError, 'SESSION_BAD_SIGNATURE');

  // No verifier configured at all must not fall back to trusting the header.
  const noVerifier = resolvePrincipal({ headers: { authorization: 'Bearer anything' } });
  assert.equal(noVerifier.anonymous, true);
  assert.equal(noVerifier.sessionError, 'SESSION_NO_VERIFIER');

  const anon = { headers: { 'x-anon-id': 'client-9' } };
  assert.deepEqual(resolvePrincipal(anon), { principalId: 'anon:client-9', anonymous: true });

  // No claim at all still resolves to *a* stable principal, so the limit cannot
  // be dodged by simply omitting the header.
  assert.deepEqual(resolvePrincipal({ headers: {} }), { principalId: 'anon:default', anonymous: true });
  // An empty bearer is not an identity.
  assert.deepEqual(resolvePrincipal({ headers: { authorization: 'Bearer   ' } }), { principalId: 'anon:default', anonymous: true });
});

test('one consume() charges exactly one budget, never both', () => {
  const store = new EntitlementStore();
  store.consume(USER, KIND.AGENT);
  const l = store.ledger(USER);
  assert.equal(l.agentTrialUsed + l.dailyUsed, 1, 'a single charge must not be split across buckets');
  assert.equal(l.lastCharge, undefined, 'lastCharge is not part of the public ledger');
});
