/**
 * kernel.mjs — the deterministic boundary.
 *
 * THE INVARIANT (quoted in every product that gets this right):
 *
 *     The model explains facts; it never computes them.
 *
 * It is enforced structurally, not by prompt wording: `narrationPrompt(facts)`
 * accepts a `Facts` object and nothing else, and `Facts` is already fully
 * resolved before narration begins. The narrator module has no access to the
 * clock, the timezone database, or the calendar — so it *cannot* do calendar
 * math even by accident. Calendar arithmetic that the model improvises is the
 * single most common source of wrong output in this product category, and no
 * amount of prompt engineering fixes a model that has been handed the job.
 *
 * Everything below marked TODO is a stub. A production kernel replaces it with
 * a real ephemeris/calendar library (solar terms, true-solar-time longitude
 * correction, DST history, the 23:00-vs-00:00 day-boundary convention, hidden
 * stems, ten gods, luck cycles). The *interface* is the part worth copying; the
 * stub is only here so the skeleton runs.
 *
 * @module kernel
 */

/** Conventional pillar order. Year first because that is how they are spoken. */
export const PILLARS = Object.freeze(['year', 'month', 'day', 'hour']);

const HEAVENLY_STEMS = Object.freeze([
  'jia', 'yi', 'bing', 'ding', 'wu', 'ji', 'geng', 'xin', 'ren', 'gui',
]);
const EARTHLY_BRANCHES = Object.freeze([
  'zi', 'chou', 'yin', 'mao', 'chen', 'si',
  'wu', 'wei', 'shen', 'you', 'xu', 'hai',
]);

/** Errors thrown by the deterministic layer — never by the narration layer. */
export class KernelError extends Error {
  /**
   * @param {string} code Machine-readable, so the client renders copy instead of
   *   string-matching a message.
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @typedef {object} Facts
 * @property {object} input          Normalized echo of the request.
 * @property {object} calendar       Calendar corrections that were applied.
 * @property {object} fourPillars    year/month/day/hour, each {stem, branch, ganzhi}.
 * @property {object} derived        Deterministic derived values (stub: element counts).
 * @property {string[]} notes        Human-readable provenance for the UI's audit view.
 * @property {string} kernelVersion  Which engine produced this — needed to explain
 *                                   a change to a user who saved an old report.
 * @property {number} computedAt     Epoch ms.
 * @property {string[]} todos        Explicit gaps; surfaced rather than hidden so
 *                                   a half-built kernel cannot masquerade as a full one.
 */

/**
 * Pure function: same input -> same Facts, no I/O, no clock reads.
 *
 * Purity is what makes the whole product auditable: given a saved request you
 * can regenerate the exact chart years later, and you can diff two kernel
 * versions to explain why a report changed.
 *
 * @param {{date: string, time?: string, timezone?: string, gender?: 'male'|'female'|'unspecified', calendar?: 'solar'|'lunar'}} input
 * @returns {Facts}
 */
export function computeFacts(input) {
  const normalized = normalizeInput(input);

  // TODO(kernel): replace this whole block with a real calendar engine:
  //   1. resolve the civil time in `timezone` (needs historical tz/DST data),
  //   2. optionally apply true-solar-time longitude correction,
  //   3. resolve the 23:00 vs 00:00 day boundary convention,
  //   4. place the year boundary at the solar term Li Chun, not Jan 1,
  //   5. derive hidden stems, ten gods, na-yin, void branches, luck cycles.
  const pillars = stubPillars(normalized);

  return {
    input: normalized,
    calendar: {
      calendar: normalized.calendar,
      timezone: normalized.timezone,
      // Stub: no correction performed. A real kernel records each correction it
      // applied so the UI can show *why* a boundary case resolved as it did.
      trueSolarTime: false,
      dayBoundaryConvention: 'stub:not-applied',
      yearBoundary: 'stub:not-applied',
      longitudeCorrectionMinutes: 0,
      dstApplied: false,
    },
    fourPillars: pillars,
    derived: {
      // Placeholder aggregate so downstream code has a stable shape to read.
      elementCounts: stubElementCounts(pillars),
    },
    notes: [
      'stub kernel: pillar values are placeholders, not astronomical output',
      'stub kernel: no timezone/DST/true-solar-time correction applied',
    ],
    kernelVersion: 'stub-0.1.0',
    computedAt: 0, // no clock read: purity over convenience. The handler stamps time.
    todos: [
      'replace stubPillars with a real calendar engine',
      'add true-solar-time longitude correction',
      'add DST/timezone history table',
      'add hidden stems / ten gods / luck cycles',
    ],
  };
}

/**
 * Validates and normalizes the caller's input. Kept separate from computation
 * so the HTTP layer can reject bad input with the same typed error codes the
 * kernel uses.
 *
 * @param {object} input
 * @returns {object}
 */
export function normalizeInput(input) {
  if (!input || typeof input !== 'object') {
    throw new KernelError('INVALID_INPUT', 'input must be an object');
  }
  const { date, time = '00:00', timezone = 'UTC', gender = 'unspecified', calendar = 'solar' } = input;

  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new KernelError('INVALID_DATE', 'date must be YYYY-MM-DD');
  }
  const [y, m, d] = date.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    throw new KernelError('INVALID_DATE', `date out of range: ${date}`);
  }
  if (typeof time !== 'string' || !/^\d{2}:\d{2}$/.test(time)) {
    throw new KernelError('INVALID_TIME', 'time must be HH:MM');
  }
  const [hh, mm] = time.split(':').map(Number);
  if (hh > 23 || mm > 59) {
    throw new KernelError('INVALID_TIME', `time out of range: ${time}`);
  }
  // A timezone is not decoration: every pillar boundary (solar terms, the 23:00
  // day cut) is evaluated against it, so a bogus zone silently charts the wrong
  // day. `Intl` is the arbiter of whether an IANA zone exists.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new KernelError('INVALID_TIMEZONE', `unknown IANA timezone: ${timezone}`);
  }
  if (calendar === 'lunar') {
    // Refusing honestly beats guessing: a solar/lunar mix-up silently produces a
    // chart for the wrong day, which the user cannot detect from the prose.
    throw new KernelError('INVALID_LUNAR_DATE', 'lunar input is not supported by the stub kernel');
  }
  if (calendar !== 'solar') {
    throw new KernelError('INVALID_CALENDAR', `unknown calendar: ${calendar}`);
  }
  if (!['male', 'female', 'unspecified'].includes(gender)) {
    throw new KernelError('INVALID_GENDER', `unknown gender: ${gender}`);
  }
  const yearValid = y >= 1900 && y <= 2100;
  if (!yearValid) {
    throw new KernelError('INVALID_DATE', 'year must be within 1900..2100 for the stub kernel');
  }
  return { date, time, timezone, gender, calendar, year: y, month: m, day: d, hour: hh, minute: mm };
}

/**
 * Deterministic *placeholder* pillars.
 *
 * These are computed from the digit values so that the output is stable and
 * obviously fake at a glance. They are NOT calendrically meaningful and the
 * returned Facts say so in `notes` and `todos`.
 *
 * @param {object} n normalized input
 * @returns {Record<string, {stem: string, branch: string, ganzhi: string}>}
 */
function stubPillars(n) {
  /** @param {number} a @param {number} b */
  const pair = (a, b) => {
    const stem = HEAVENLY_STEMS[((a % 10) + 10) % 10];
    const branch = EARTHLY_BRANCHES[((b % 12) + 12) % 12];
    return { stem, branch, ganzhi: `${stem}-${branch}` };
  };
  return {
    year: pair(n.year - 1900, n.year - 1900 + 1),
    month: pair(n.year + n.month, n.month),
    day: pair(n.year + n.month + n.day, n.day),
    hour: pair(n.hour, Math.floor(n.hour / 2)),
  };
}

/** Placeholder element tally; keeps the shape stable for the narration layer. */
function stubElementCounts(pillars) {
  const counts = {};
  for (const p of PILLARS) {
    const key = pillars[p].stem;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Renders Facts as a structured block for the model.
 *
 * Why a structured block and not prose: the model's job is to *explain* values
 * it was handed. A labelled block makes it unambiguous which numbers are
 * authoritative, and it keeps the prompt free of the computation rules — the
 * model never sees the formula, so it has nothing to re-derive (and therefore
 * nothing to re-derive incorrectly).
 *
 * @param {Facts} facts
 * @returns {string}
 */
export function narrationPrompt(facts) {
  if (!facts || typeof facts !== 'object' || !facts.fourPillars) {
    throw new KernelError('FACTS_REQUIRED', 'narrationPrompt requires a Facts object');
  }
  const lines = [];
  lines.push('## FACTS (authoritative, do not recompute)');
  lines.push('');
  lines.push('### Input');
  lines.push(`- date: ${facts.input.date}`);
  lines.push(`- time: ${facts.input.time}`);
  lines.push(`- timezone: ${facts.input.timezone}`);
  lines.push(`- gender: ${facts.input.gender}`);
  lines.push('');
  lines.push('### Four pillars');
  for (const key of PILLARS) {
    const p = facts.fourPillars[key];
    lines.push(`- ${key}: ${p.ganzhi} (stem=${p.stem}, branch=${p.branch})`);
  }
  lines.push('');
  lines.push('### Calendar corrections applied by the kernel');
  lines.push(`- trueSolarTime: ${facts.calendar.trueSolarTime}`);
  lines.push(`- dayBoundaryConvention: ${facts.calendar.dayBoundaryConvention}`);
  lines.push(`- yearBoundary: ${facts.calendar.yearBoundary}`);
  lines.push(`- kernelVersion: ${facts.kernelVersion}`);
  lines.push('');
  lines.push('### Derived values');
  for (const [key, value] of Object.entries(facts.derived.elementCounts ?? {})) {
    lines.push(`- elementCount.${key}: ${value}`);
  }
  lines.push('');
  lines.push('### Kernel notes');
  for (const note of facts.notes) lines.push(`- ${note}`);
  lines.push('');
  lines.push('RULES:');
  lines.push('1. Explain the facts above. Do not compute, correct, or "fix" any value.');
  lines.push('2. Never state a pillar, stem, branch or date that is not listed above.');
  lines.push('3. If the facts look wrong, say so and stop — do not substitute your own.');
  return lines.join('\n');
}

export default { computeFacts, narrationPrompt, normalizeInput, PILLARS, KernelError };
