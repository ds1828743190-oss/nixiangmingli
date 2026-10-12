/**
 * helpers.mjs — shared test utilities.
 *
 * The important one is `tokenFor`. Before sessions were signed, a test could put
 * any string in the Authorization header and get an identity, so tests silently
 * documented the hole instead of the contract. Now every authenticated test mints
 * a real token with the same key its server was started with.
 *
 * @module test/helpers
 */

import { listen } from '../src/server.mjs';
import { createSessionVerifier } from '../src/session.mjs';

/** The key every test server is started with. 32 bytes, not a passphrase. */
export const TEST_SECRET = 'test-only-secret-0123456789abcdef';

const verifier = createSessionVerifier({ secret: TEST_SECRET });

/** A signed token for `sub`. Use `bearer()` when you just need a header. */
export function tokenFor(sub, opts = {}) {
  return verifier.mint({ sub, ...opts });
}

/** `{ authorization: 'Bearer <signed>' }` — spread into fetch headers. */
export function bearer(sub, opts = {}) {
  return { authorization: `Bearer ${tokenFor(sub, opts)}` };
}

/** Boots a server sharing TEST_SECRET, unless the caller overrides it. */
export async function boot(opts = {}) {
  const { server, baseUrl } = await listen({ sessionSecret: TEST_SECRET, frameDelayMs: 0, ...opts });
  return {
    baseUrl,
    server,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export default { TEST_SECRET, tokenFor, bearer, boot };
