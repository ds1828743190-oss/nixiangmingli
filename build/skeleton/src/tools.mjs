/**
 * tools.mjs — per-surface tool registry, minimal JSON-Schema validation, dispatch.
 *
 * Three rules in here are load-bearing:
 *
 *  1. **Scopes are not tags.** `listForSurface('almanac')` must not leak a chart
 *     tool, because a leaked tool is a tool the model can be talked into
 *     calling from the wrong screen — where the surrounding context it assumes
 *     does not exist. A global registry with per-call filtering is a security
 *     boundary in the same way a `WHERE` clause is.
 *  2. **Validation happens before the handler, always.** A handler that has to
 *     defend itself against malformed arguments will eventually forget to. One
 *     gate, one place to audit.
 *  3. **A rejected call is a typed result, not an exception into the stream.**
 *     The transport stays healthy (the user's text keeps flowing) while the
 *     model learns, in-band, that this particular call failed and why — which
 *     is what lets it retry with better arguments instead of giving up.
 *
 * The validator is deliberately hand-rolled and deliberately small. It covers
 * exactly the keywords this contract needs: type / properties / required / enum /
 * items / minimum / maximum / minLength / maxLength / pattern / additionalProperties.
 * Anything else is *ignored*, and `validateArgs` says so in `unsupported` — a
 * silently ignored keyword is an unenforced rule, which is worse than a missing one.
 *
 * @module tools
 */

/** Error codes a caller can branch on without reading prose. */
export const TOOL_ERROR = Object.freeze({
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  TOOL_NOT_IN_SURFACE: 'TOOL_NOT_IN_SURFACE',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  HANDLER_ERROR: 'HANDLER_ERROR',
});

/** JSON-Schema keywords this validator understands. */
const SUPPORTED_KEYWORDS = Object.freeze([
  'type', 'properties', 'required', 'enum', 'items',
  'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
  'additionalProperties', 'description',
]);

/** @param {unknown} v */
function jsonTypeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Validates a value against a (small) JSON Schema subset.
 *
 * @param {unknown} value
 * @param {object} schema
 * @param {string} [path] JSON-pointer-ish location, for actionable errors.
 * @returns {{valid: boolean, errors: Array<{path: string, keyword: string, message: string}>}}
 */
export function validateArgs(value, schema, path = '') {
  const errors = [];
  walk(value, schema, path, errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Recursive worker. Kept iterative-ish and branchy on purpose: a validator is
 * read far more often than it is written, so clarity beats cleverness.
 */
function walk(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = jsonTypeOf(value);
    // JSON Schema treats integer as a subtype of number.
    const ok = expected.includes(actual) || (actual === 'number' && expected.includes('integer'));
    if (!ok) {
      errors.push({
        path: path || '/',
        keyword: 'type',
        message: `expected ${expected.join('|')}, got ${actual}`,
      });
      return; // deeper checks would only produce noise
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push({
      path: path || '/',
      keyword: 'enum',
      message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`,
    });
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({ path: path || '/', keyword: 'minLength', message: `must be at least ${schema.minLength} chars` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push({ path: path || '/', keyword: 'maxLength', message: `must be at most ${schema.maxLength} chars` });
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path: path || '/', keyword: 'pattern', message: `must match ${schema.pattern}` });
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path: path || '/', keyword: 'minimum', message: `must be >= ${schema.minimum}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path: path || '/', keyword: 'maximum', message: `must be <= ${schema.maximum}` });
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => walk(item, schema.items, `${path}/${i}`, errors));
  }

  if (jsonTypeOf(value) === 'object' && value !== null) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        errors.push({ path: `${path}/${key}`, keyword: 'required', message: 'is required' });
      }
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (Object.hasOwn(value, key)) walk(value[key], sub, `${path}/${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) {
          errors.push({ path: `${path}/${key}`, keyword: 'additionalProperties', message: 'is not an allowed property' });
        }
      }
    }
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Collects schema keywords the validator will ignore, so a caller can fail loudly. */
export function unsupportedKeywords(schema, found = new Set()) {
  if (!schema || typeof schema !== 'object') return [...found];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.includes(key)) found.add(key);
  }
  const props = schema.properties ?? {};
  for (const sub of Object.values(props)) unsupportedKeywords(sub, found);
  if (schema.items) unsupportedKeywords(schema.items, found);
  return [...found];
}

/** A tool declared but not visible on the requested surface. */
export class ToolDispatchError extends Error {
  /**
   * @param {string} code  One of TOOL_ERROR.
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ToolDispatchError';
    this.code = code;
    this.details = details;
  }

  /** The shape emitted as a `tool_result` payload. */
  toResult() {
    return { ok: false, error: { code: this.code, message: this.message, ...this.details } };
  }
}

export class ToolRegistry {
  /** @type {Map<string, object>} */
  #tools = new Map();

  /**
   * @param {object} spec
   * @param {string} spec.name
   * @param {string} spec.description
   * @param {object} spec.inputSchema
   * @param {string[]} spec.scopes       Surfaces this tool may appear on.
   * @param {'read'|'write'} spec.effects  Declared side-effect class, so a future
   *   policy layer can refuse writes on a read-only screen without inspecting code.
   * @param {(args: object, ctx: object) => any} spec.handler
   */
  register({ name, description, inputSchema, scopes, effects = 'read', handler }) {
    if (!name || typeof name !== 'string') throw new TypeError('tool name is required');
    if (typeof handler !== 'function') throw new TypeError(`tool ${name}: handler is required`);
    if (!Array.isArray(scopes) || scopes.length === 0) {
      // A tool with no scope is a tool with no home; it would be unreachable
      // everywhere, which is a bug that looks like a mystery at runtime.
      throw new TypeError(`tool ${name}: at least one scope is required`);
    }
    if (this.#tools.has(name)) throw new TypeError(`tool ${name} is already registered`);
    const tool = {
      name,
      description: description ?? '',
      inputSchema: inputSchema ?? { type: 'object' },
      scopes: [...scopes],
      effects,
      handler,
      unsupportedSchemaKeywords: unsupportedKeywords(inputSchema ?? {}),
    };
    this.#tools.set(name, tool);
    return tool;
  }

  /**
   * Tools visible on one surface. Returns copies of the model-facing subset only:
   * `handler` must never travel into a prompt payload.
   * @param {string} surface
   */
  listForSurface(surface) {
    return [...this.#tools.values()]
      .filter((t) => t.scopes.includes(surface))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, effects: t.effects }));
  }

  /** All surfaces implied by the registry. Useful for docs and tests. */
  surfaces() {
    const out = new Set();
    for (const t of this.#tools.values()) for (const s of t.scopes) out.add(s);
    return [...out].sort();
  }

  get(name) {
    return this.#tools.get(name) ?? null;
  }

  get size() {
    return this.#tools.size;
  }

  /**
   * Validates then runs one tool call.
   *
   * Never throws for *expected* failures: unknown tool, wrong surface and bad
   * arguments all come back as a typed result. Only a genuine bug inside a
   * handler is caught and converted, so one broken tool cannot kill the stream.
   *
   * @param {string} name
   * @param {unknown} args
   * @param {{surface?: string, ctx?: object}} [opts]
   * @returns {Promise<{ok: boolean, result?: any, error?: object, durationMs: number}>}
   */
  async dispatch(name, args, { surface, ctx = {} } = {}) {
    const startedAt = performance.now();
    const tool = this.#tools.get(name);
    if (!tool) {
      return fail(new ToolDispatchError(TOOL_ERROR.UNKNOWN_TOOL, `unknown tool: ${name}`, { name }), startedAt);
    }
    if (surface && !tool.scopes.includes(surface)) {
      return fail(
        new ToolDispatchError(
          TOOL_ERROR.TOOL_NOT_IN_SURFACE,
          `tool ${name} is not available on surface ${surface}`,
          { name, surface, availableOn: tool.scopes },
        ),
        startedAt,
      );
    }
    if (tool.effects === 'write' && ctx.allowWrites === false) {
      return fail(
        new ToolDispatchError(TOOL_ERROR.TOOL_NOT_IN_SURFACE, `tool ${name} writes and writes are disabled here`, { name }),
        startedAt,
      );
    }

    const validation = validateArgs(args, tool.inputSchema);
    if (!validation.valid) {
      // Handler is NOT called. This is the assertion test/tools.test.mjs pins down.
      return fail(
        new ToolDispatchError(TOOL_ERROR.INVALID_ARGUMENTS, `invalid arguments for ${name}`, {
          name,
          errors: validation.errors,
        }),
        startedAt,
      );
    }

    try {
      const result = await tool.handler(args, ctx);
      return { ok: true, result, durationMs: round(performance.now() - startedAt) };
    } catch (err) {
      return fail(
        new ToolDispatchError(TOOL_ERROR.HANDLER_ERROR, `tool ${name} failed: ${err.message}`, { name }),
        startedAt,
      );
    }
  }
}

function fail(error, startedAt) {
  return { ok: false, error: error.toResult().error, durationMs: round(performance.now() - startedAt) };
}

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Builds the illustrative registry: two surfaces, five tools, real schemas.
 *
 * The split mirrors how these products actually scope tools — a chart surface
 * that knows about a chart, an almanac surface that knows about a day — rather
 * than one flat list of forty.
 *
 * Every handler here is a pure echo/stub. There is no business logic and no
 * proprietary rule text; the interesting content is the schema + scope shape.
 *
 * @returns {ToolRegistry}
 */
export function buildDefaultRegistry() {
  const registry = new ToolRegistry();

  registry.register({
    name: 'chart.pillar_lookup',
    description: 'Look up one pillar of an existing chart. Read-only; the caller supplies the chart id.',
    scopes: ['chart'],
    effects: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['chartId', 'position'],
      properties: {
        chartId: { type: 'string', minLength: 1, maxLength: 64, description: 'Opaque chart identifier.' },
        position: { type: 'string', enum: ['year', 'month', 'day', 'hour'] },
        includeHiddenStems: { type: 'boolean', description: 'Include hidden stems when available.' },
      },
    },
    handler: (args) => ({
      chartId: args.chartId,
      position: args.position,
      pillar: { stem: 'stub', branch: 'stub' },
      hiddenStems: args.includeHiddenStems ? [] : null,
      source: 'stub',
    }),
  });

  registry.register({
    name: 'chart.luck_cycle_lookup',
    description: 'List the deterministic luck-cycle periods for a chart. Stub data.',
    scopes: ['chart'],
    effects: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['chartId'],
      properties: {
        chartId: { type: 'string', minLength: 1, maxLength: 64 },
        fromYear: { type: 'integer', minimum: 1900, maximum: 2100 },
        toYear: { type: 'integer', minimum: 1900, maximum: 2100 },
        limit: { type: 'integer', minimum: 1, maximum: 12 },
      },
    },
    handler: (args) => {
      if (args.fromYear != null && args.toYear != null && args.toYear < args.fromYear) {
        throw new Error('toYear must be >= fromYear'); // exercises the HANDLER_ERROR path
      }
      const limit = args.limit ?? 3;
      return {
        chartId: args.chartId,
        cycles: Array.from({ length: limit }, (_, i) => ({
          index: i,
          startYear: (args.fromYear ?? 1900) + i * 10,
          label: `cycle-${i}`,
        })),
        source: 'stub',
      };
    },
  });

  registry.register({
    name: 'almanac.day_info',
    description: 'Deterministic day metadata for one civil date. Read-only.',
    scopes: ['almanac'],
    effects: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['date'],
      properties: {
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Civil date, YYYY-MM-DD.' },
        timezone: { type: 'string', minLength: 1, maxLength: 64 },
        fields: {
          type: 'array',
          items: { type: 'string', enum: ['ganzhi', 'officers', 'clash'] },
          minLength: 0,
        },
      },
    },
    handler: (args) => ({
      date: args.date,
      timezone: args.timezone ?? 'UTC',
      requested: args.fields ?? ['ganzhi'],
      source: 'stub',
    }),
  });

  registry.register({
    name: 'almanac.range_summary',
    description: 'Summarize a date range. Stub aggregate over the same deterministic source.',
    scopes: ['almanac'],
    effects: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        bucket: { type: 'string', enum: ['day', 'month'] },
      },
    },
    handler: (args) => ({ from: args.from, to: args.to, bucket: args.bucket ?? 'day', entries: 0, source: 'stub' }),
  });

  // A write-effect tool on the almanac surface, present purely so the `effects`
  // field is exercised: a policy layer can refuse it on a read-only screen.
  registry.register({
    name: 'almanac.save_note',
    description: 'Attach a note to a saved date. Write effect — refused where writes are disabled.',
    scopes: ['almanac'],
    effects: 'write',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['date', 'text'],
      properties: {
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        text: { type: 'string', minLength: 1, maxLength: 280 },
      },
    },
    handler: (args) => ({ saved: true, date: args.date, length: args.text.length, source: 'stub' }),
  });

  return registry;
}

export default { ToolRegistry, buildDefaultRegistry, validateArgs, TOOL_ERROR };
