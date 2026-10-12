/**
 * narrator.mjs — the narration layer, with the model faked out.
 *
 * There is no network call here and no API key: `planNarration` turns a `Facts`
 * object into a fixed, deterministic list of frames. That is a feature, not a
 * shortcut — it means the transport contracts can be tested without a provider,
 * a key, a rate limit, or a token budget, and a red test always means the
 * protocol broke rather than "the model had a bad day".
 *
 * Two boundary rules are enforced by construction:
 *
 *  - The narrator reads **only** `Facts`. It has no clock, no timezone database
 *    and no calendar functions, so it cannot recompute a pillar even by mistake.
 *    This is the "model explains facts, it never computes them" invariant made
 *    structural instead of aspirational.
 *  - Tool calls go through the registry, so every call is schema-validated and
 *    surfaced as `tool_call` + `tool_result` frames. The prose is *not* allowed
 *    to mention a tool result the protocol did not carry — otherwise the UI's
 *    "called N tools" affordance and the text would disagree.
 *
 * Order of the emitted NDJSON frames is the contract's UI semantics:
 *
 *     conversation_id → reasoning… → phase_change → tool_call/tool_result… → content… → end
 *
 * `reasoning` and `content` are separate phases because they render in separate
 * places (a collapsed "thinking" panel vs the answer body); `phase_change` is
 * the explicit boundary between them, so the client never has to guess when the
 * thinking panel should stop growing.
 *
 * @module narrator
 */

import { AGENT_FRAME, CHAT_EVENT, agentFrames } from './frames.mjs';

/** Kinds of NDJSON frame the narrator can emit, in the order it emits them. */
export const NARRATION_SEQUENCE = Object.freeze([
  AGENT_FRAME.CONVERSATION_ID,
  AGENT_FRAME.REASONING,
  AGENT_FRAME.PHASE_CHANGE,
  AGENT_FRAME.TOOL_CALL,
  AGENT_FRAME.TOOL_RESULT,
  AGENT_FRAME.CONTENT,
  AGENT_FRAME.ERROR,
]);

/** Tool calls the fake narrator makes, per surface. Fixed so tests are stable. */
const TOOL_PLAN = Object.freeze({
  chart: Object.freeze([
    { name: 'chart.pillar_lookup', arguments: { chartId: 'chart-demo-1', position: 'day', includeHiddenStems: true } },
    { name: 'chart.luck_cycle_lookup', arguments: { chartId: 'chart-demo-1', fromYear: 1990, toYear: 2050, limit: 3 } },
  ]),
  almanac: Object.freeze([
    { name: 'almanac.day_info', arguments: { date: '2000-01-01', timezone: 'UTC', fields: ['ganzhi'] } },
  ]),
});

/** Which surface a request should use, from the facts' own shape. */
export function surfaceForFacts(facts) {
  // A chart id is what distinguishes "explain this person's chart" from
  // "tell me about this day". Real routing is a server decision; the skeleton
  // keeps it explicit and inspectable rather than inferred from prompt text.
  return facts?.input?.chartId ? 'chart' : 'almanac';
}

/**
 * The canned tool plan, with its arguments bound to the facts.
 *
 * Binding is not cosmetic: a hardcoded date makes the demo ask the almanac about
 * a different day than the chart it just claimed to explain — precisely the
 * "the model invented a value" failure this architecture exists to prevent, and
 * poison for anyone copying the skeleton as a pattern. Determinism survives
 * (facts are deterministic), so the tests stay stable.
 *
 * @param {string} surface
 * @param {import('./kernel.mjs').Facts} facts
 */
function resolveDefaultToolPlan(surface, facts) {
  return (TOOL_PLAN[surface] ?? []).map((call) => {
    const args = { ...call.arguments };
    // Only rebind the fields the call actually declares; inventing new fields
    // would make the call fail its own inputSchema.
    if (args.date !== undefined) args.date = facts.input.date;
    if (args.timezone !== undefined) args.timezone = facts.input.timezone;
    return { ...call, arguments: args };
  });
}

/**
 * Plans the whole narration as an array of *pre-protocol* steps.
 *
 * Pure and synchronous: no I/O, no timers, no randomness. Two calls with the
 * same facts and registry produce byte-identical output, which is what makes
 * resume-by-replay safe and snapshot tests meaningful.
 *
 * @param {import('./kernel.mjs').Facts} facts
 * @param {import('./tools.mjs').ToolRegistry} registry
 * @param {{surface?: string, conversationId?: string, toolPlan?: object[]}} [opts]
 *   `toolPlan` overrides the canned calls. Tests use it to present the registry
 *   with arguments a real model would plausibly get wrong (a bad enum, a missing
 *   field) and observe the gate — without the skeleton shipping a deliberately
 *   broken default.
 * @returns {object[]} steps; each is `{kind: 'frame', frame}` or `{kind: 'tool', ...}`
 */
export function planNarration(facts, registry, { surface, conversationId = null, toolPlan } = {}) {
  if (!facts?.fourPillars) throw new TypeError('planNarration requires a Facts object');
  const chosen = surface ?? surfaceForFacts(facts);
  const toolNames = registry.listForSurface(chosen).map((t) => t.name);
  const steps = [];

  steps.push({ kind: 'frame', frame: agentFrames.conversationId(conversationId ?? 'conv_demo') });

  // --- reasoning phase: restate inputs and *name* the values it was handed.
  // Note what is absent: no arithmetic, no date parsing, no "adjust for". The
  // narrator can only quote what is already resolved.
  steps.push({
    kind: 'frame',
    frame: agentFrames.reasoning(`Reading the deterministic input for ${facts.input.date} ${facts.input.time} (${facts.input.timezone}).`),
  });
  steps.push({
    kind: 'frame',
    frame: agentFrames.reasoning(`Kernel ${facts.kernelVersion} returned four resolved pillars; I will explain them as given.`),
  });
  steps.push({
    kind: 'frame',
    frame: agentFrames.reasoning(`Surface "${chosen}" exposes ${toolNames.length} tool(s): ${toolNames.join(', ') || 'none'}.`),
  });
  steps.push({ kind: 'frame', frame: agentFrames.phaseChange() });

  // --- tool phase: each call is dispatched through the registry, so the
  // emitted tool_result is the verified outcome, never the model's account of it.
  const plan = toolPlan ?? resolveDefaultToolPlan(chosen, facts);
  plan.forEach((call, index) => {
    steps.push({ kind: 'tool', index, name: call.name, arguments: call.arguments, surface: chosen });
  });

  // --- content phase: fixed prose derived from the facts block.
  const contentText = renderExplanation(facts);
  const chunks = chunkText(contentText, 24);
  for (const chunk of chunks) steps.push({ kind: 'frame', frame: agentFrames.content(chunk) });

  return steps;
}

/**
 * Executes a plan, yielding frames in order.
 *
 * An async generator (not a callback) so the HTTP layer can apply backpressure
 * — if the client stops reading, the producer stops producing. A push-based
 * producer keeps generating into a dead socket and burns tokens for nobody.
 *
 * @param {object[]} steps
 * @param {import('./tools.mjs').ToolRegistry} registry
 * @param {{onFrame?: (frame: object) => void, frameDelayMs?: number}} [opts]
 */
export async function* runNarration(steps, registry, { onFrame, frameDelayMs = 0 } = {}) {
  for (const step of steps) {
    if (step.kind === 'frame') {
      yield await pace(step.frame);
    } else if (step.kind === 'tool') {
      // tool_call first: the UI shows the call while it is still in flight, which
      // is the only way "calling tools…" can be honest about latency.
      yield await pace(agentFrames.toolCall(step.name, step.arguments));
      const outcome = await registry.dispatch(step.name, step.arguments, { surface: step.surface });
      // A failed call is still a tool_result — the index must line up on both
      // paths, or the client's `toolCalls[index]` back-fill silently drops it.
      yield await pace(agentFrames.toolResult(step.index, outcome));
    }
  }

  /**
   * Optional pacing. Default 0 (as fast as the socket accepts). A test that
   * needs to abort mid-stream sets a small delay so frames land in separate
   * TCP writes and a partial read is genuinely partial.
   */
  async function pace(frame) {
    if (frameDelayMs > 0) await new Promise((r) => setTimeout(r, frameDelayMs));
    if (onFrame) onFrame(frame);
    return frame;
  }
}

/** Convenience wrapper: plan + run. */
export async function* narrate(facts, registry, opts = {}) {
  yield* runNarration(planNarration(facts, registry, opts), registry, opts);
}

/** Stable prose, derived only from Facts. */
function renderExplanation(facts) {
  const p = facts.fourPillars;
  const parts = [];
  parts.push(`Chart for ${facts.input.date} ${facts.input.time} (${facts.input.timezone}).`);
  parts.push(`Four pillars as resolved by kernel ${facts.kernelVersion}: ` +
    `year ${p.year.ganzhi}, month ${p.month.ganzhi}, day ${p.day.ganzhi}, hour ${p.hour.ganzhi}.`);
  parts.push(`Calendar corrections recorded by the kernel: true solar time ${facts.calendar.trueSolarTime}, ` +
    `day boundary "${facts.calendar.dayBoundaryConvention}", year boundary "${facts.calendar.yearBoundary}".`);
  parts.push(`Kernel notes: ${facts.notes.join('; ')}.`);
  parts.push('This explanation restates the resolved facts and adds no calculation of its own.');
  return parts.join(' ');
}

/** Splits text into fixed-size chunks so streaming is visible in tests. */
export function chunkText(text, size = 24) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * Maps one agent frame onto the chat (SSE) event vocabulary.
 *
 * The two transports carry the same *meaning* in different words: NDJSON has
 * first-class `reasoning`/`tool_call` types, SSE has `action` + `msg`. Keeping
 * the translation in one function is what stops the two surfaces from drifting.
 *
 * `retryable` is only true for failures the client may recover from by
 * reconnecting. A validation failure is deterministic — retrying it would
 * produce the same failure forever and burn the user's credits.
 *
 * @param {object} frame An agent NDJSON frame.
 * @returns {{event: string, msg: object, retryable: boolean}|null} null = not mapped.
 */
export function toChatEvent(frame) {
  switch (frame.type) {
    case AGENT_FRAME.REASONING:
      return { event: CHAT_EVENT.ACTION, msg: { action: 'reasoning', content: frame.content }, retryable: false };
    case AGENT_FRAME.PHASE_CHANGE:
      return { event: CHAT_EVENT.ACTION, msg: { action: 'phase_change' }, retryable: false };
    case AGENT_FRAME.TOOL_CALL:
      return {
        event: CHAT_EVENT.ACTION,
        msg: { action: 'tool_call', name: frame.toolCall.name, arguments: frame.toolCall.arguments },
        retryable: false,
      };
    case AGENT_FRAME.TOOL_RESULT:
      return {
        event: CHAT_EVENT.ACTION,
        msg: { action: 'tool_result', index: frame.index, ok: frame.result?.ok === true, result: frame.result },
        retryable: false,
      };
    case AGENT_FRAME.CONTENT:
      // `delta` carries the chunk; the client accumulates. The full text is also
      // sent once in the terminal frame so a client that reconnects mid-message
      // can render the whole answer without replaying chunk-by-chunk.
      return { event: CHAT_EVENT.MESSAGE, msg: { role: 'assistant', delta: frame.content }, retryable: false };
    case AGENT_FRAME.ERROR:
      return { event: CHAT_EVENT.ERROR, msg: { code: frame.code ?? 'INTERNAL_SERVER_ERROR', message: frame.message }, retryable: frame.retryable === true };
    default:
      return null; // conversation_id is carried by the SSE `start` frame instead
  }
}

/** Extracts the concatenated assistant text from a list of agent frames. */
export function textOf(frames) {
  return frames.filter((f) => f.type === AGENT_FRAME.CONTENT).map((f) => f.content).join('');
}

export default { planNarration, runNarration, narrate, toChatEvent, chunkText, surfaceForFacts, NARRATION_SEQUENCE };
