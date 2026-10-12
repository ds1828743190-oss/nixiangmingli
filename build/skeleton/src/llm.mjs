/**
 * llm.mjs — the seam where a real model replaces the fake narrator.
 *
 * Everything above this seam (frames, seq, resume, quota, tools, delivery) is
 * already built and tested. This module is the one place that talks to a model,
 * and it is written so that the model CANNOT do the two things this product must
 * never let it do:
 *
 *   1. **Compute the calendar.** It receives `narrationPrompt(facts)` — a block
 *      of resolved values — and the prompt states the rule. It never sees the
 *      formulas, so it has nothing to re-derive incorrectly.
 *   2. **Act on a tool call the registry rejects.** Every proposed call goes
 *      through `registry.dispatch()`, so schema validation happens before any
 *      handler runs; the rejection is fed back to the model as a typed result
 *      instead of crashing the turn.
 *
 * The wire format is a parameter, not an assumption: a `chatStream` function is
 * injected, so tests run against a fake and production injects the provider
 * adapter. The reader tolerates both NDJSON and SSE framing because providers
 * differ (one live product in this category streams NDJSON with
 * `content-type: text/plain`, the other SSE with `text/event-stream`).
 *
 * @module llm
 */

import { AGENT_FRAME, agentFrames, NdjsonParser, SseParser } from './frames.mjs';
import { narrationPrompt } from './kernel-active.mjs';

/**
 * @typedef {object} WireEvent
 * @property {'reasoning'|'content'|'tool_call'|'error'|'done'} type
 * @property {string} [text]        For reasoning/content.
 * @property {{name: string, arguments: object}} [call]  For tool_call.
 * @property {string} [message]     For error.
 */

/**
 * Reads provider events from anything that yields byte chunks.
 *
 * Two framings are accepted because both are real: NDJSON (`{"...":...}\n`) and
 * SSE (`data: {...}\n\n`). Plain JSON fragments are also accepted, which is what
 * a provider sends when it streams one JSON object per chunk without a delimiter.
 *
 * Chunk boundaries are arbitrary — a JSON object split across three sockets must
 * still parse. That is the whole reason this is a streaming parser and not a
 * `for line of text` loop.
 *
 * @param {AsyncIterable<Uint8Array|string>} chunks
 * @returns {AsyncGenerator<WireEvent>}
 */
export async function* readWireEvents(chunks) {
  const decoder = new TextDecoder();
  const sse = new SseParser();
  const ndjson = new NdjsonParser();
  let buffer = '';

  for await (const chunk of chunks) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buffer += text;

    // 1) SSE blocks (terminated by a blank line)
    while (buffer.includes('\n\n')) {
      const cut = buffer.indexOf('\n\n') + 2;
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      for (const frame of sse.push(block)) {
        const ev = toWireEvent(frame);
        if (ev) yield ev;
      }
    }

    // 2) line-delimited JSON
    if (buffer.includes('\n')) {
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const frame of ndjson.push(`${lines.join('\n')}\n`)) {
        const ev = toWireEvent(frame);
        if (ev) yield ev;
      }
    }
  }

  // Trailing bytes with no delimiter: accept a single complete JSON value.
  const tail = (buffer + decoder.decode()).trim();
  if (tail) {
    for (const raw of [tail, tail.replace(/^data:\s?/, '')]) {
      try {
        const ev = toWireEvent(JSON.parse(raw));
        if (ev) { yield ev; break; }
      } catch { /* not a complete value; drop it rather than inventing output */ }
    }
  }
}

/**
 * Maps a provider chunk onto a wire event. Recognises the shapes real providers
 * use for chain-of-thought (`reasoning_content` / `reasoning`) versus answer text
 * (`content`), plus OpenAI-style `tool_calls`.
 *
 * @param {any} frame
 * @returns {WireEvent|null}
 */
export function toWireEvent(frame) {
  if (!frame || typeof frame !== 'object') return null;
  const choice = frame.choices?.[0];
  const delta = choice?.delta ?? choice?.message ?? frame.delta ?? frame;
  if (!delta || typeof delta !== 'object') return null;

  const calls = delta.tool_calls;
  if (Array.isArray(calls) && calls.length > 0) {
    const c = calls[0];
    let args = c.function?.arguments ?? c.arguments ?? {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = { __unparsed: args }; }
    }
    return { type: 'tool_call', call: { name: c.function?.name ?? c.name, arguments: args } };
  }
  // Reasoning FIRST: providers that emit both must not have thinking leak into
  // the answer pane, and the protocol carries them as distinct frame types.
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === 'string' && reasoning.length > 0) return { type: 'reasoning', text: reasoning };
  if (typeof delta.content === 'string' && delta.content.length > 0) return { type: 'content', text: delta.content };
  if (frame.error) return { type: 'error', message: frame.error.message ?? String(frame.error) };
  const finish = choice?.finish_reason ?? frame.finish_reason;
  if (finish) return { type: 'done' };
  return null;
}

/**
 * The system prompt. Short on purpose: the authoritative block is the facts, and
 * a long style prompt competes with it for the model's attention.
 * @param {import('./kernel.mjs').Facts} facts
 */
export function systemPrompt(facts) {
  return [
    'You are a Chinese-metaphysics reading assistant.',
    'You explain the FACTS you are given. You never compute, correct, or "fix" them,',
    'and you never state a pillar, date, or value that is not present in FACTS.',
    'If FACTS are missing or look wrong, say so and stop.',
    '',
    narrationPrompt(facts),
  ].join('\n');
}

/**
 * Turns a model's stream into protocol frames, running the tool loop.
 *
 * @param {object} opts
 * @param {import('./kernel.mjs').Facts} opts.facts
 * @param {import('./tools.mjs').ToolRegistry} opts.registry
 * @param {string} opts.surface
 * @param {(req: {messages: object[], signal?: AbortSignal}) => AsyncIterable<Uint8Array|string>} opts.chatStream
 * @param {string} [opts.conversationId]
 * @param {string} [opts.question]
 * @param {number} [opts.maxToolRounds] Hard cap; a model that loops must not bill forever.
 * @param {AbortSignal} [opts.signal]
 * @returns {AsyncGenerator<object>} protocol-A frames
 */
export async function* narrateWithModel({
  facts, registry, surface, chatStream, conversationId = null, question = '', maxToolRounds = 3, signal,
}) {
  if (!facts?.fourPillars) throw new TypeError('narrateWithModel requires a Facts object');
  if (typeof chatStream !== 'function') throw new TypeError('narrateWithModel requires a chatStream function');

  yield agentFrames.conversationId(conversationId ?? 'conv_llm');

  const messages = [
    { role: 'system', content: systemPrompt(facts) },
    { role: 'user', content: question || 'Explain this chart.' },
  ];

  let phaseOpened = false;
  const openPhase = () => {
    if (!phaseOpened) { phaseOpened = true; return true; }
    return false;
  };

  for (let round = 0; round <= maxToolRounds; round += 1) {
    let sawToolCall = false;

    for await (const event of readWireEvents(chatStream({ messages, signal }))) {
      if (signal?.aborted) return;

      if (event.type === 'reasoning') {
        yield agentFrames.reasoning(event.text);
      } else if (event.type === 'content') {
        // Exactly one phase_change, immediately before the first answer token:
        // the client uses it to collapse the thinking pane.
        if (openPhase()) yield agentFrames.phaseChange();
        yield agentFrames.content(event.text);
      } else if (event.type === 'tool_call') {
        if (openPhase()) yield agentFrames.phaseChange();
        sawToolCall = true;
        const { name, arguments: args } = event.call;
        yield agentFrames.toolCall(name, args);
        let result;
        try {
          // The gate: invalid arguments never reach the handler. `dispatch` is
          // async AND returns typed failures instead of throwing (unknown tool,
          // wrong surface, bad arguments, handler error), so both shapes must be
          // handled — a rejected call is data for the model to correct, not a
          // fatal error that ends the turn.
          const out = await registry.dispatch(name, args ?? {}, { surface });
          result = out.ok
            ? { ok: true, result: out.result }
            : { ok: false, code: out.error?.code ?? 'TOOL_ERROR', message: out.error?.message ?? 'tool refused', details: out.error };
        } catch (err) {
          result = { ok: false, code: err.code ?? 'TOOL_ERROR', message: err.message, details: err.details ?? undefined };
        }
        yield agentFrames.toolResult(round, result);
        messages.push({ role: 'assistant', content: null, tool_calls: [{ function: { name, arguments: JSON.stringify(args ?? {}) } }] });
        messages.push({ role: 'tool', name, content: JSON.stringify(result) });
      } else if (event.type === 'error') {
        yield agentFrames.error(event.message ?? 'model stream failed');
        return;
      }
    }

    if (!sawToolCall) break;
  }

  yield agentFrames.keepAlive();
}

/**
 * Minimal provider adapter: NDJSON-over-HTTP with bearer auth.
 *
 * Deliberately dumb and dependency-free. It exists so that wiring a real key is
 * a one-line change at the composition root, and so the model call is the ONLY
 * place a secret is read.
 *
 * @param {{baseUrl: string, apiKey: string, model: string, fetchImpl?: typeof fetch}} cfg
 * @returns {(req: {messages: object[], signal?: AbortSignal}) => AsyncGenerator<Uint8Array>}
 */
export function createChatStream({ baseUrl, apiKey, model, fetchImpl = fetch }) {
  if (!baseUrl) throw new TypeError('createChatStream requires baseUrl');
  if (!apiKey) throw new TypeError('createChatStream requires apiKey (read it from the environment, never from source)');
  return async function* chatStream({ messages, signal }) {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
    if (!res.ok) {
      // Read the body for the provider's own error text. Provider error bodies
      // sometimes echo the credential back (a "bad key sk-..." message), so the
      // key is scrubbed before the text is allowed anywhere near a log or frame.
      const detail = await res.text().catch(() => '');
      const redacted = apiKey ? detail.split(apiKey).join('[redacted]').slice(0, 200) : detail.slice(0, 200);
      throw new Error(`model request failed: HTTP ${res.status} ${redacted}`);
    }
    for await (const chunk of res.body) yield chunk;
  };
}

export { AGENT_FRAME };
export default { narrateWithModel, readWireEvents, toWireEvent, systemPrompt, createChatStream, AGENT_FRAME };
