/**
 * tools.test.mjs — scope isolation and the "validate before you run" gate.
 *
 * The two assertions that would catch a real regression:
 *  - a handler must never run when arguments fail validation (counted, not
 *    eyeballed);
 *  - a tool must never be listable on a surface it was not scoped to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry, buildDefaultRegistry, validateArgs, unsupportedKeywords, TOOL_ERROR } from '../src/tools.mjs';

test('the default registry exposes two surfaces and five tools', () => {
  const registry = buildDefaultRegistry();
  assert.equal(registry.size, 5);
  assert.deepEqual(registry.surfaces(), ['almanac', 'chart']);
  assert.deepEqual(registry.listForSurface('chart').map((t) => t.name), ['chart.pillar_lookup', 'chart.luck_cycle_lookup']);
  assert.equal(registry.listForSurface('almanac').length, 3);
});

test('listForSurface is a real boundary: no cross-surface leakage', () => {
  const registry = buildDefaultRegistry();
  const chartNames = registry.listForSurface('chart').map((t) => t.name);
  const almanacNames = registry.listForSurface('almanac').map((t) => t.name);
  assert.equal(chartNames.some((n) => almanacNames.includes(n)), false);
  assert.deepEqual(registry.listForSurface('nonexistent'), []);
  // The model-facing listing must never carry the handler closure.
  for (const t of registry.listForSurface('chart')) {
    assert.equal('handler' in t, false);
    assert.ok(t.inputSchema && t.description);
  }
});

test('registering a tool with no scope is rejected', () => {
  const registry = new ToolRegistry();
  assert.throws(
    () => registry.register({ name: 'x', scopes: [], handler: () => ({}) }),
    /at least one scope/,
  );
  assert.throws(() => registry.register({ name: 'x', scopes: ['a'] }), /handler is required/);
});

test('valid arguments reach the handler and return an ok result', async () => {
  const registry = buildDefaultRegistry();
  const outcome = await registry.dispatch('chart.pillar_lookup', { chartId: 'c1', position: 'day' }, { surface: 'chart' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.chartId, 'c1');
  assert.equal(typeof outcome.durationMs, 'number');
});

test('INVALID arguments never reach the handler', async () => {
  // A dedicated registry with a spy handler, so "never called" is observed
  // rather than inferred from the shape of a result.
  const registry = new ToolRegistry();
  let calls = 0;
  registry.register({
    name: 'spy.tool',
    description: 'counts invocations',
    scopes: ['chart'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['chartId', 'position'],
      properties: {
        chartId: { type: 'string', minLength: 1 },
        position: { type: 'string', enum: ['year', 'month', 'day', 'hour'] },
      },
    },
    handler: () => {
      calls += 1;
      return { ok: true };
    },
  });

  const cases = [
    [{ position: 'day' }, 'required'], // missing chartId
    [{ chartId: '', position: 'day' }, 'minLength'],
    [{ chartId: 'c', position: 'century' }, 'enum'],
    [{ chartId: 7, position: 'day' }, 'type'],
    [{ chartId: 'c', position: 'day', extra: true }, 'additionalProperties'],
    ['not-an-object', 'type'],
  ];

  for (const [args, keyword] of cases) {
    const outcome = await registry.dispatch('spy.tool', args, { surface: 'chart' });
    assert.equal(outcome.ok, false, JSON.stringify(args));
    assert.equal(outcome.error.code, TOOL_ERROR.INVALID_ARGUMENTS);
    assert.ok(
      outcome.error.errors.some((e) => e.keyword === keyword),
      `expected keyword ${keyword} in ${JSON.stringify(outcome.error.errors)}`,
    );
  }
  assert.equal(calls, 0, 'handler was invoked despite invalid arguments');
});

test('a valid call after failed ones still works (the gate is per-call)', async () => {
  const registry = buildDefaultRegistry();
  const bad = await registry.dispatch('almanac.day_info', { date: '01-01-2000' }, { surface: 'almanac' });
  assert.equal(bad.ok, false);
  const good = await registry.dispatch('almanac.day_info', { date: '2000-01-01' }, { surface: 'almanac' });
  assert.equal(good.ok, true);
  assert.equal(good.result.date, '2000-01-01');
});

test('dispatching a tool off its surface is refused with a typed code', async () => {
  const registry = buildDefaultRegistry();
  const outcome = await registry.dispatch('chart.pillar_lookup', { chartId: 'c', position: 'day' }, { surface: 'almanac' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, TOOL_ERROR.TOOL_NOT_IN_SURFACE);
  assert.deepEqual(outcome.error.availableOn, ['chart']);
});

test('unknown tool is a typed result, not a thrown exception', async () => {
  const registry = buildDefaultRegistry();
  const outcome = await registry.dispatch('no.such_tool', {}, { surface: 'chart' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, TOOL_ERROR.UNKNOWN_TOOL);
});

test('a handler that throws becomes a typed HANDLER_ERROR, so one bad tool cannot kill the stream', async () => {
  const registry = buildDefaultRegistry();
  const outcome = await registry.dispatch(
    'chart.luck_cycle_lookup',
    { chartId: 'c', fromYear: 2000, toYear: 1990 },
    { surface: 'chart' },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, TOOL_ERROR.HANDLER_ERROR);
  assert.match(outcome.error.message, /toYear/);
});

test('write-effect tools can be refused where writes are disabled', async () => {
  const registry = buildDefaultRegistry();
  const blocked = await registry.dispatch('almanac.save_note', { date: '2000-01-01', text: 'hi' }, { surface: 'almanac', ctx: { allowWrites: false } });
  assert.equal(blocked.ok, false);
  const allowed = await registry.dispatch('almanac.save_note', { date: '2000-01-01', text: 'hi' }, { surface: 'almanac' });
  assert.equal(allowed.ok, true);
});

test('validateArgs reports every failure with a path, not just the first', () => {
  const schema = {
    type: 'object',
    required: ['a', 'b'],
    properties: { a: { type: 'string' }, b: { type: 'integer', minimum: 3 }, c: { type: 'array', items: { type: 'string' } } },
  };
  const result = validateArgs({ b: 1, c: ['ok', 2] }, schema);
  assert.equal(result.valid, false);
  const keywords = result.errors.map((e) => e.keyword);
  assert.ok(keywords.includes('required'), 'missing a');
  assert.ok(keywords.includes('minimum'), 'b below minimum');
  assert.ok(keywords.includes('type'), 'c[1] wrong type');
  assert.ok(result.errors.some((e) => e.path === '/c/1'));
});

test('unsupported schema keywords are surfaced, not silently ignored', () => {
  const registry = new ToolRegistry();
  const tool = registry.register({
    name: 't',
    scopes: ['s'],
    inputSchema: { type: 'object', properties: { a: { type: 'string', oneOf: [{ const: 'x' }] } } },
    handler: () => ({}),
  });
  assert.deepEqual(tool.unsupportedSchemaKeywords, ['oneOf']);
  assert.deepEqual(unsupportedKeywords({ type: 'object' }), []);
});
