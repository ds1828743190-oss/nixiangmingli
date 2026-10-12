/**
 * kernel-active.mjs — which deterministic kernel the server actually runs.
 *
 * Two implementations exist on purpose:
 *
 *   • `./kernel.mjs`      — the stub. Placeholder pillars, every gap listed in
 *                           `Facts.todos`. It exists so the streaming/quota/tool
 *                           layers can be developed and read without a calendar
 *                           engine, and so the docs can point at a toy example.
 *   • `../../kernel/`     — the real kernel: anchored sexagenary day count,
 *                           立春 year boundary, 节 month boundary, 五虎遁/五鼠遁,
 *                           IANA timezone handling, measured term accuracy.
 *
 * Real wins by default, because a skeleton that silently ships placeholder
 * charts is worse than no skeleton. `SHENSHA_KERNEL=stub` switches back, which
 * is how the stub-specific tests stay runnable.
 *
 * The choice is made once, at import time, so nothing downstream can hold two
 * kernels at the same time and disagree about a pillar.
 *
 * @module kernel-active
 */

const which = process.env.SHENSHA_KERNEL === 'stub' ? 'stub' : 'real';

const mod = which === 'stub'
  ? await import('./kernel.mjs')
  : await import('../../kernel/index.mjs').catch((err) => {
    // Falling back silently would hide a broken/missing real kernel behind
    // plausible-looking placeholder charts, so refuse loudly instead.
    throw new Error(`SHENSHA_KERNEL=real but ../../kernel/index.mjs could not be loaded: ${err.message}`);
  });

/** Which implementation is live — surfaced for /health-style diagnostics and tests. */
export const activeKernel = which;

export const computeFacts = mod.computeFacts;
export const normalizeInput = mod.normalizeInput;
export const narrationPrompt = mod.narrationPrompt;
export const KernelError = mod.KernelError;
export const PILLARS = mod.PILLARS;

export default mod;
