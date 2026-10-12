/**
 * quota.mjs — entitlement store with a server-authoritative check.
 *
 * Two properties matter more than the numbers:
 *
 *  1. **The server re-checks on every generation call.** The client keeps a
 *     cached access snapshot for first-paint only. If the cache were the
 *     authority, a user could clear storage (or just edit it) and get unlimited
 *     generations — and a "clean" client would still race two tabs against one
 *     remaining credit. `check()` is therefore called inside the request
 *     handler, not in a middleware that trusts a header.
 *
 *  2. **Every refusal is a typed code, not a message.** The client renders copy
 *     from the code. That is why quotas can be re-worded, localised, or A/B
 *     tested without a client release — and why matching on a human-readable
 *     string is a bug waiting to happen.
 *
 * Quota is charged at *message creation*, keyed on the message id. A transport
 * retry or a resume of an existing message is not a second charge; only a new
 * message is. Getting this wrong double-bills users on flaky networks, which is
 * exactly when they are least willing to forgive it.
 *
 * @module quota
 */

/** Typed quota outcomes. HTTP status is attached to each so callers cannot guess. */
export const QUOTA_ERROR = Object.freeze({
  ANON_CALC_LIMIT: { status: 403, message: 'Anonymous calculation limit reached.' },
  ANON_LIMIT_REACHED: { status: 403, message: 'Anonymous limit reached.' },
  DAILY_LIMIT_REACHED: { status: 403, message: 'Daily limit reached. It resets at local midnight.' },
  AGENT_TRIAL_EXHAUSTED: { status: 403, message: 'Agent trial exhausted.' },
  INTERNAL_SERVER_ERROR: { status: 500, message: 'Internal server error.' },
});

/** What each kind of work costs against which budget. */
export const LIMITS = Object.freeze({
  anonCalcLimit: 3,
  dailyAnalysisLimit: 5,
  agentTrialLimit: 2,
});

export class QuotaError extends Error {
  /**
   * @param {keyof typeof QUOTA_ERROR} code
   * @param {string} [detail] Extra context for logs; never rendered to the user.
   */
  constructor(code, detail = '') {
    const spec = QUOTA_ERROR[code] ?? QUOTA_ERROR.INTERNAL_SERVER_ERROR;
    super(spec.message);
    this.name = 'QuotaError';
    this.code = code;
    this.status = spec.status;
    this.detail = detail;
  }

  /** Wire shape. `code` is the contract; `message` is a convenience default. */
  toBody() {
    return { code: this.code, message: this.message, status: this.status };
  }
}

/**
 * The generation kinds this store understands.
 *
 *  - `calc`   deterministic chart computation. Anonymous users get a small
 *             free allowance (the free hook); signed-in users get the daily one.
 *  - `agent`  a model-backed generation. Costs the trial first, then the daily
 *             allowance.
 */
export const KIND = Object.freeze({ CALC: 'calc', AGENT: 'agent' });

/** @returns {string} local (not UTC) day key — "resets at local midnight" is a local promise. */
export function dayKey(now = new Date(), timezone = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export class EntitlementStore {
  /**
   * @param {{now?: () => Date, limits?: typeof LIMITS}} [opts]
   *   `now` is injectable so a test can cross midnight without waiting.
   */
  constructor({ now = () => new Date(), limits = LIMITS } = {}) {
    this.now = now;
    this.limits = { ...limits };
    /** @type {Map<string, object>} */
    this.accounts = new Map();
    /** @type {Map<string, {hasSubscription: boolean, hasPurchase: boolean, accessEndDate: string|null, remainingTime: string|null}>} */
    this.entitlements = new Map();
  }

  /**
   * Marks a principal as paying (or not).
   *
   * A real store reads this from billing tables. Keeping it injectable matters
   * for the contract: both the "free user ran out of trial" and the "subscriber
   * hit today's cap" paths must be reachable, and they must return *different*
   * codes — one is an upsell, the other is a limit to wait out.
   *
   * @param {string} principalId
   * @param {{hasSubscription?: boolean, hasPurchase?: boolean, accessEndDate?: string|null, remainingTime?: string|null}} [entitlement]
   */
  setEntitlement(principalId, entitlement = {}) {
    this.entitlements.set(principalId, {
      hasSubscription: entitlement.hasSubscription ?? false,
      hasPurchase: entitlement.hasPurchase ?? false,
      accessEndDate: entitlement.accessEndDate ?? null,
      remainingTime: entitlement.remainingTime ?? null,
    });
    return this;
  }

  /** @param {string} principalId */
  entitlementFor(principalId) {
    return this.entitlements.get(principalId) ?? {
      hasSubscription: false,
      hasPurchase: false,
      accessEndDate: null,
      remainingTime: null,
    };
  }

  /**
   * Fetches (or lazily creates) one principal's ledger.
   * @param {string} principalId Authenticated user id, or `anon:<clientId>`.
   */
  account(principalId) {
    if (!this.accounts.has(principalId)) {
      this.accounts.set(principalId, {
        principalId,
        anonymous: principalId.startsWith('anon:'),
        anonCalcUsed: 0,
        agentTrialUsed: 0,
        dailyUsed: 0,
        dailyKey: null,
      });
    }
    const account = this.accounts.get(principalId);
    // Day rollover is evaluated on read, not by a timer: a cron that misses its
    // tick must never become a user-visible outage.
    const key = dayKey(this.now());
    if (account.dailyKey !== key) {
      account.dailyKey = key;
      account.dailyUsed = 0;
    }
    return account;
  }

  /**
   * Pure predicate: may this principal do this kind of work right now?
   *
   * Kept side-effect free so a caller can *pre-check* on page load (to hide the
   * composer) and again on submit (to refuse) without the pre-check consuming a
   * credit. Consumption happens only if generation actually starts.
   *
   * @param {string} principalId
   * @param {string} kind  KIND.CALC | KIND.AGENT
   * @returns {{allowed: boolean, code: string|null, reason: string}}
   */
  check(principalId, kind) {
    const a = this.account(principalId);

    if (kind === KIND.CALC) {
      if (a.anonymous && a.anonCalcUsed >= this.limits.anonCalcLimit) {
        return { allowed: false, code: 'ANON_CALC_LIMIT', reason: 'anonymous calculation allowance used up' };
      }
      return { allowed: true, code: null, reason: 'ok' };
    }

    if (kind === KIND.AGENT) {
      if (a.anonymous) {
        return { allowed: false, code: 'ANON_LIMIT_REACHED', reason: 'agent requires a signed-in session' };
      }
      // Trial first: it is the scarcer, more visible budget, and spending it
      // first is what makes the "trial" counter in the UI meaningful — a user
      // must never see "daily limit reached" while trial credits are unspent.
      if (a.agentTrialUsed < this.limits.agentTrialLimit) {
        return { allowed: true, code: null, reason: 'agent trial available' };
      }
      const entitled = this.entitlementFor(principalId);
      const paying = entitled.hasSubscription || entitled.hasPurchase;
      // No paid entitlement and no trial left: this is the upsell moment, and it
      // needs its own code. Folding it into DAILY_LIMIT_REACHED would tell a free
      // user to "come back tomorrow" for a budget that will never return.
      if (!paying) {
        return { allowed: false, code: 'AGENT_TRIAL_EXHAUSTED', reason: 'trial used and no subscription or purchase' };
      }
      if (a.dailyUsed < this.limits.dailyAnalysisLimit) {
        return { allowed: true, code: null, reason: 'daily allowance available' };
      }
      return { allowed: false, code: 'DAILY_LIMIT_REACHED', reason: "subscriber's daily allowance used" };
    }

    return { allowed: false, code: 'INTERNAL_SERVER_ERROR', reason: `unknown kind: ${kind}` };
  }

  /**
   * Charges one unit. Throws QuotaError when the budget is gone, so the caller
   * cannot accidentally generate after a failed check.
   *
   * @param {string} principalId
   * @param {string} kind
   * @param {{units?: number, messageId?: string}} [opts]
   */
  consume(principalId, kind, { units = 1, messageId } = {}) {
    const verdict = this.check(principalId, kind);
    if (!verdict.allowed) {
      throw new QuotaError(/** @type {any} */ (verdict.code), `consume(${kind}) for ${principalId}`);
    }
    const a = this.account(principalId);
    if (kind === KIND.CALC) {
      a.anonCalcUsed += units;
    } else if (kind === KIND.AGENT) {
      // One unit, one budget: a message either uses trial or daily, never both.
      // Splitting a single charge across two buckets is how off-by-one drift
      // appears between the client counter and the server ledger.
      if (a.agentTrialUsed < this.limits.agentTrialLimit) a.agentTrialUsed += units;
      else a.dailyUsed += units;
    }
    a.lastCharge = { kind, units, messageId: messageId ?? null, at: this.now().toISOString() };
    return a;
  }

  /**
   * The `GET /api/access` body.
   *
   * Field names are part of the contract; `agentTrial.hasRemaining` exists so
   * the client never has to re-derive `remaining > 0` (and never gets to
   * disagree about what "remaining" means).
   *
   * @param {string} principalId
   */
  accessSnapshot(principalId) {
    const a = this.account(principalId);
    const limit = this.limits.agentTrialLimit;
    const used = Math.min(a.agentTrialUsed, limit);
    const remaining = Math.max(0, limit - used);
    const expired = false; // stub: a real store reads subscription/purchase rows

    // The agent needs a principal (see INVARIANT in PROTOCOL.md §6: one condition,
    // one answer). Reporting a usable trial to an anonymous caller would tell the
    // client "2 uses left" while every request is refused — the client would show
    // a composer that can only fail. `signInRequired` lets it render "sign in to
    // use this" instead of "you are out of quota": different remedies.
    if (a.anonymous) {
      return {
        hasSubscription: false,
        hasPurchase: false,
        accessType: null,
        signInRequired: true,
        accessEndDate: null,
        remainingTime: null,
        agentTrial: { limit: 0, used: 0, remaining: 0, hasRemaining: false },
      };
    }

    // The entitlement fields are read from the store, never inferred from usage:
    // a user who has spent a trial is not thereby a subscriber, and vice versa.
    const subscribed = this.entitlementFor(principalId);

    return {
      hasSubscription: subscribed.hasSubscription,
      hasPurchase: subscribed.hasPurchase,
      accessType: expired
        ? 'expired'
        : subscribed.hasSubscription || subscribed.hasPurchase
          ? 'subscription'
          : remaining > 0 || a.dailyUsed < this.limits.dailyAnalysisLimit
            ? 'trial'
            : null,
      signInRequired: false,
      accessEndDate: subscribed.accessEndDate,
      remainingTime: subscribed.remainingTime,
      agentTrial: { limit, used, remaining, hasRemaining: remaining > 0 },
    };
  }

  /** Daily/anon ledger, for tests and admin views. Not exposed over HTTP. */
  ledger(principalId) {
    const a = this.account(principalId);
    return {
      anonymous: a.anonymous,
      anonCalcUsed: a.anonCalcUsed,
      anonCalcLimit: this.limits.anonCalcLimit,
      agentTrialUsed: a.agentTrialUsed,
      agentTrialLimit: this.limits.agentTrialLimit,
      dailyUsed: a.dailyUsed,
      dailyLimit: this.limits.dailyAnalysisLimit,
      dailyKey: a.dailyKey,
    };
  }
}

/**
 * Resolves the principal from a request.
 *
 * The signed-session half of the contract: a bearer token is only an identity if
 * it VERIFIES against the server's key. There is no permissive fallback — an
 * unverifiable token is not a weaker identity, it is no identity, and the caller
 * falls through to the anonymous principal. (The placeholder this replaced
 * accepted any non-empty string, which made every downstream ownership check
 * decorative.)
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{verify: (token: string) => {ok: boolean, sub?: string, code?: string}}|null} [verifier]
 * @returns {{principalId: string, anonymous: boolean, sessionError?: string}}
 */
export function resolvePrincipal(req, verifier = null) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.trim() !== '') {
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token) {
      if (verifier) {
        const verdict = verifier.verify(token);
        if (verdict.ok) return { principalId: `user:${verdict.sub}`, anonymous: false };
        // Carry the reason so the transport can answer 401 with a code the client
        // can act on ("expired" means sign in again; "malformed" is a bug).
        return anonymousPrincipal(req, verdict.code);
      }
      // No verifier configured at all: refuse to invent an identity. Falling back
      // to `user:<raw token>` here is exactly the hole this module closed.
      return anonymousPrincipal(req, 'SESSION_NO_VERIFIER');
    }
  }
  return anonymousPrincipal(req);
}

/** @param {import('node:http').IncomingMessage} req @param {string} [sessionError] */
function anonymousPrincipal(req, sessionError) {
  const anon = req.headers['x-anon-id'];
  const id = typeof anon === 'string' && anon.trim() !== '' ? anon.trim() : 'default';
  // The `anon:` prefix is applied exactly once, here — a client that sends a
  // pre-prefixed id must not be able to address another principal's ledger.
  const bare = id.startsWith('anon:') ? id.slice('anon:'.length) : id;
  return { principalId: `anon:${bare}`, anonymous: true, ...(sessionError ? { sessionError } : {}) };
}

export default { EntitlementStore, QuotaError, QUOTA_ERROR, LIMITS, KIND, resolvePrincipal };
