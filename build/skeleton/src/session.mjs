/**
 * session.mjs — signed session tokens, replacing "any non-empty bearer".
 *
 * The placeholder it replaces was actively dangerous: a client could become any
 * user by sending `Authorization: Bearer <anything>`, so every quota, idempotency
 * and stream-ownership check downstream was decorative. Ownership is only as real
 * as the identity it is checked against.
 *
 * Design choices, and why:
 *
 *  - **HMAC-SHA256 over a compact payload, not a JWT library.** The token carries
 *    only a subject and an expiry; a JWT library would add surface (algorithm
 *    negotiation, nested claims) that this endpoint has no use for. There is no
 *    `alg` field to confuse, because the algorithm is not negotiable.
 *  - **Constant-time comparison** (`timingSafeEqual`) with an explicit length
 *    guard: a byte-by-byte `===` leaks how much of a guessed signature was right,
 *    which is enough to forge one byte at a time.
 *  - **Explicit failure codes**, so the transport can answer 401 and the client
 *    can distinguish "expired" (re-login) from "malformed" (bug).
 *  - **No secret in the token.** The signing key lives only in the process; a
 *    leaked token is a leaked session, not a leaked key.
 *
 * @module session
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
/** Failure codes. `SESSION_*` never reach the client verbatim except as a code. */
export const SESSION_ERROR = Object.freeze({
  MALFORMED: 'SESSION_MALFORMED',
  UNSUPPORTED: 'SESSION_UNSUPPORTED_VERSION',
  BAD_SIGNATURE: 'SESSION_BAD_SIGNATURE',
  EXPIRED: 'SESSION_EXPIRED',
  NO_SUBJECT: 'SESSION_NO_SUBJECT',
});

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const unb64url = (s) => Buffer.from(s, 'base64url');

/**
 * @typedef {object} SessionVerifier
 * @property {(token: string, now?: number) => {ok: true, sub: string, exp: number} | {ok: false, code: string}} verify
 * @property {(opts: {sub: string, ttlSeconds?: number, now?: number}) => string} mint
 * @property {boolean} ephemeral  true when the key was generated at startup
 */

/**
 * @param {{secret?: string|Buffer, ttlSeconds?: number}} [opts]
 * @returns {SessionVerifier}
 */
export function createSessionVerifier({ secret, ttlSeconds = 3600 } = {}) {
  const ephemeral = secret === undefined || secret === null || secret === '';
  // An ephemeral key keeps a dev/demo instance usable without pretending it is
  // secure: restarts invalidate every session, and `ephemeral` is surfaced so the
  // server can say so out loud rather than silently running on a random key.
  const key = ephemeral ? randomBytes(32) : Buffer.from(secret);
  if (key.length < 16) {
    throw new Error('session secret must be at least 16 bytes');
  }

  /** @param {string} payloadB64 */
  const sign = (payloadB64) => b64url(createHmac('sha256', key).update(`${VERSION}.${payloadB64}`).digest());

  /** @param {Buffer} a @param {Buffer} b */
  const safeEqual = (a, b) => {
    // Length is not secret (the digest length is fixed), but timingSafeEqual
    // throws on a mismatch, so guard explicitly and still compare in constant time.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  };

  return {
    ephemeral,
    mint({ sub, ttlSeconds: ttl = ttlSeconds, now = Date.now() }) {
      if (typeof sub !== 'string' || sub.trim() === '') throw new Error('mint requires a subject');
      const iat = Math.floor(now / 1000);
      const payload = b64url(JSON.stringify({ sub, iat, exp: iat + ttl }));
      return `${VERSION}.${payload}.${sign(payload)}`;
    },
    verify(token, now = Date.now()) {
      if (typeof token !== 'string' || token === '') return { ok: false, code: SESSION_ERROR.MALFORMED };
      const parts = token.split('.');
      if (parts.length !== 3) return { ok: false, code: SESSION_ERROR.MALFORMED };
      const [version, payloadB64, sigB64] = parts;
      if (version !== VERSION) return { ok: false, code: SESSION_ERROR.UNSUPPORTED };

      // Signature first: parsing an unverified payload is how parsers get tricked
      // by hostile input, and it keeps the failure for a forged token uniform.
      let presented;
      try {
        presented = unb64url(sigB64);
      } catch {
        return { ok: false, code: SESSION_ERROR.MALFORMED };
      }
      const expected = unb64url(sign(payloadB64));
      if (!safeEqual(presented, expected)) return { ok: false, code: SESSION_ERROR.BAD_SIGNATURE };

      let claims;
      try {
        claims = JSON.parse(unb64url(payloadB64).toString('utf8'));
      } catch {
        return { ok: false, code: SESSION_ERROR.MALFORMED };
      }
      if (typeof claims?.sub !== 'string' || claims.sub.trim() === '') {
        return { ok: false, code: SESSION_ERROR.NO_SUBJECT };
      }
      if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
        // A token without an expiry is a token that never dies; refuse rather than
        // treat it as immortal.
        return { ok: false, code: SESSION_ERROR.MALFORMED };
      }
      if (Math.floor(now / 1000) >= claims.exp) return { ok: false, code: SESSION_ERROR.EXPIRED };
      return { ok: true, sub: claims.sub, exp: claims.exp };
    },
  };
}

export default { createSessionVerifier, SESSION_ERROR };
