/**
 * index.mjs — the real deterministic kernel.
 *
 * THE INVARIANT (the reason this file exists at all):
 *
 *     The model explains facts; it never computes them.
 *
 * So this is the only place in the product allowed to do calendar arithmetic:
 * local time → UTC, solar-term instants, the 立春 year boundary, the 节 month
 * boundary, the sexagenary day count, the hour branch. The narration layer
 * receives the finished `Facts` object and the prompt block that renders it.
 *
 * Accuracy is reported, not implied. `calendar.termAccuracySeconds` carries the
 * measured error of the solar-longitude implementation, and
 * `calendar.boundaryUncertainty` flags a birth that falls inside that error
 * window around a 节 — because silently picking a side is exactly the failure
 * this architecture forbids. See build/verify/kernel-accuracy.md.
 *
 * @module kernel
 */

import { equationOfTimeMinutesAtUtc } from './astro.mjs';
// Solar-term instants come from the VSOP87D path (astro-vsop87.mjs): the compact
// Kepler-solve approximation in astro.mjs stays for ΔT/equation-of-time helpers
// but is no longer what decides a pillar boundary.
import { solarTermInstant } from './astro-vsop87.mjs';
import {
  dayCycleIndex, yearCycleIndex, monthPillar, hourPillar, elementCounts, pillarFromIndices,
} from './pillars.mjs';

export const PILLARS = Object.freeze(['year', 'month', 'day', 'hour']);

export class KernelError extends Error {
  /**
   * @param {string} code
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
 * Measured upper bound on this implementation's solar-term error, in seconds.
 *
 * This number is a *measurement*, not a margin of comfort, and it is the input
 * to every boundary decision downstream (year pillar at 立春, month pillar at
 * each 節). It was re-derived each time the ephemeris improved:
 *
 *   v1 (Meeus low-precision formula, mod-360 bug): max |error| = 970 s (~16 min)
 *   v2 (Kepler solve + equation of centre + aberration + nutation, calibrated):
 *       max 528 s (8.8 min), RMS 222 s, over 50 published 節/中氣 instants
 *   v3 (full VSOP87D Earth series, astro-vsop87.mjs) — CURRENT:
 *       max 9.6 s, mean 4.7 s over the same 50 published instants;
 *       an independent 17-instant table agrees to 17.3 s.
 *
 * The bound below is deliberately ~6x the measured maximum rather than the
 * measurement itself: the published tables' own rounding is unknown, and an
 * *understated* window silently resolves genuine boundary cases the wrong way —
 * the exact failure this architecture exists to prevent. A slightly wide window
 * only means a few extra births get an honest "verify your birth time" note.
 *
 * DO NOT shrink this without re-measuring against a published table.
 */
export const TERM_ACCURACY_SECONDS = 60;

/**
 * The 12 節 that govern months: longitude, name, month ordinal (1 = 寅/立春),
 * and a civil-date hint used to seed the root finder. The hint matters: a bad
 * seed can bracket a *different* year's occurrence and look like a one-year bug.
 */
const JIE_TABLE = Object.freeze([
  { longitude: 315, name: 'lichun', zh: '立春', ordinal: 1, hint: [2, 4] },
  { longitude: 345, name: 'jingzhe', zh: '惊蛰', ordinal: 2, hint: [3, 5] },
  { longitude: 15, name: 'qingming', zh: '清明', ordinal: 3, hint: [4, 4] },
  { longitude: 45, name: 'lixia', zh: '立夏', ordinal: 4, hint: [5, 5] },
  { longitude: 75, name: 'mangzhong', zh: '芒种', ordinal: 5, hint: [6, 5] },
  { longitude: 105, name: 'xiaoshu', zh: '小暑', ordinal: 6, hint: [7, 7] },
  { longitude: 135, name: 'liqiu', zh: '立秋', ordinal: 7, hint: [8, 7] },
  { longitude: 165, name: 'bailu', zh: '白露', ordinal: 8, hint: [9, 7] },
  { longitude: 195, name: 'hanlu', zh: '寒露', ordinal: 9, hint: [10, 8] },
  { longitude: 225, name: 'lidong', zh: '立冬', ordinal: 10, hint: [11, 7] },
  { longitude: 255, name: 'daxue', zh: '大雪', ordinal: 11, hint: [12, 7] },
  { longitude: 285, name: 'xiaohan', zh: '小寒', ordinal: 12, hint: [1, 5, +1] }, // January of the NEXT civil year
]);

/** A term instant computed once per (solar year, term); the cache is per-process. */
const termCache = new Map();

/**
 * Instant (epoch ms) of one 節 in a given solar year — the year that begins at
 * 立春. `小寒` therefore belongs to the *next* civil year.
 * @param {{longitude: number, hint: number[]}} term
 * @param {number} solarYear
 */
function termInstant(term, solarYear) {
  const [month, day, yearShift = 0] = term.hint;
  const key = `${term.longitude}:${solarYear}`;
  const hit = termCache.get(key);
  if (hit !== undefined) return hit;
  const guess = Date.UTC(solarYear + yearShift, month - 1, day, 4, 0, 0);
  const instant = solarTermInstant(term.longitude, guess, 20);
  termCache.set(key, instant);
  return instant;
}

/** 立春 of a civil year — the year-pillar boundary. */
function lichunOf(civilYear) {
  return termInstant(JIE_TABLE[0], civilYear);
}

/**
 * The 節 governing an instant, searched over the solar year that contains it.
 * @param {number} instant epoch ms
 */
function governingJie(instant) {
  const civilYear = new Date(instant).getUTCFullYear();
  let best = null;
  for (const solarYear of [civilYear - 1, civilYear, civilYear + 1]) {
    for (const term of JIE_TABLE) {
      const t = termInstant(term, solarYear);
      if (t <= instant && (best === null || t > best.instant)) best = { term, instant: t, solarYear };
    }
  }
  if (!best) throw new KernelError('TERM_LOOKUP_FAILED', 'could not locate the governing solar term');
  return best;
}

// ---------------------------------------------------------------------------
// Timezone handling
// ---------------------------------------------------------------------------

/**
 * Offset of an IANA zone at an instant, in minutes east of UTC.
 *
 * Derived from Intl rather than a hand-rolled table so that the host's tzdata —
 * including historical DST — is the single source of truth. Limitation: it is
 * only as good as the ICU data shipped with the runtime.
 */
export function zoneOffsetMinutes(instant, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instant));
    const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
    const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return Math.round((asIfUtc - instant) / 60000);
  } catch {
    throw new KernelError('INVALID_TIMEZONE', `unknown IANA timezone: ${timezone}`);
  }
}

/**
 * Local civil time → epoch ms, with explicit, documented DST behaviour.
 *
 * HISTORY: an earlier revision used a naive two-pass guess (offset at the naive
 * UTC reading, then offset at that candidate). That is WRONG at a DST spring-
 * forward gap: for 2024-03-10 02:30 America/New_York it returned 06:30Z while
 * also reporting an offset of -300 min, and 06:30Z is actually 01:30 EST — so the
 * recorded offset did not describe the recorded instant, and the local time was
 * off by an hour. That is precisely the silent-correction failure this kernel
 * exists to prevent, so it is fixed properly here.
 *
 * The algorithm below resolves the ambiguity by *construction* rather than by
 * guesswork:
 *   1. take o1 = offset at the naive reading, and the candidate it implies;
 *   2. if that candidate renders back to the requested wall clock, it is a real
 *      instant — use it;
 *   3. otherwise the requested local time is either non-existent (spring-forward
 *      gap) or duplicated (autumn overlap):
 *        • gap      → the first candidate renders LATER than requested (we were
 *                     pushed across the transition); use max(o1,o2), which is the
 *                     standard "shift forward by the gap" reading (02:30 → 03:30);
 *        • overlap  → use min(o1,o2), i.e. the FIRST of the two occurrences.
 * In every branch `zoneOffsetMinutes(instant)` provably reproduces `instant`, so
 * `calendar.utcOffsetMinutes` and `calendar.instantUtc` never disagree.
 *
 * @returns {number} epoch ms
 */
export function localToInstant(year, month, day, hour, minute, timezone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const o1 = zoneOffsetMinutes(naive, timezone);
  const candidate1 = naive - o1 * 60000;
  if (rendersAs(candidate1, timezone, year, month, day, hour, minute)) return candidate1;

  const o2 = zoneOffsetMinutes(candidate1, timezone);
  const candidate2 = naive - o2 * 60000;
  if (rendersAs(candidate2, timezone, year, month, day, hour, minute)) return candidate2;

  // Wall clock does not exist (gap) or exists twice (overlap) under either guess.
  const rendered = renderedWallClock(candidate2, timezone);
  const requested = { year, month, day, hour, minute };
  const pushedForward = compareWallClock(rendered, requested) > 0;
  const chosenOffset = pushedForward ? Math.max(o1, o2) : Math.min(o1, o2);
  return naive - chosenOffset * 60000;
}

/** Wall-clock fields of an instant as rendered in `timezone`. */
function renderedWallClock(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

/** Compare two wall-clock field sets: -1 / 0 / +1. */
function compareWallClock(a, b) {
  const ka = [a.year, a.month, a.day, a.hour, a.minute];
  const kb = [b.year, b.month, b.day, b.hour, b.minute];
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  }
  return 0;
}

/** True when `instant` renders exactly as the requested wall clock. */
function rendersAs(instant, timezone, year, month, day, hour, minute) {
  return compareWallClock(
    renderedWallClock(instant, timezone),
    { year, month, day, hour, minute },
  ) === 0;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * @typedef {object} BirthInput
 * @property {string} date      YYYY-MM-DD (Gregorian, local civil date)
 * @property {string} [time]    HH:MM local civil time
 * @property {string} [timezone] IANA zone
 * @property {'male'|'female'|'unspecified'} [gender]
 * @property {'solar'|'lunar'} [calendar]
 * @property {'midnight'|'zi-chu'} [dayBoundary]
 * @property {boolean} [useTrueSolarTime]
 * @property {number} [longitude] degrees east, required when useTrueSolarTime
 */

/**
 * Validates and normalizes birth input. Throws typed `KernelError`s.
 * @param {BirthInput} input
 */
export function normalizeInput(input) {
  if (!input || typeof input !== 'object') throw new KernelError('INVALID_INPUT', 'input must be an object');
  const {
    date, time = '00:00', timezone = 'UTC', gender = 'unspecified', calendar = 'solar',
    dayBoundary = 'midnight', useTrueSolarTime = false, longitude = null,
  } = input;

  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new KernelError('INVALID_DATE', 'date must be YYYY-MM-DD');
  }
  const [y, m, d] = date.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new KernelError('INVALID_DATE', `date out of range: ${date}`);
  if (y < 1900 || y > 2100) throw new KernelError('INVALID_DATE', 'year must be within 1900..2100');

  if (time === null) {
    // An unknown hour is a real answer, not a bad one. This kernel cannot yet
    // express a chart without an hour pillar, so it refuses instead of defaulting.
    throw new KernelError('BIRTH_TIME_REQUIRED', 'time is required by this kernel (unknown-hour charts are not implemented)');
  }
  if (typeof time !== 'string' || !/^\d{2}:\d{2}$/.test(time)) throw new KernelError('INVALID_TIME', 'time must be HH:MM');
  const [hh, mm] = time.split(':').map(Number);
  if (hh > 23 || mm > 59) throw new KernelError('INVALID_TIME', `time out of range: ${time}`);

  if (typeof timezone !== 'string' || timezone.length === 0) throw new KernelError('INVALID_TIMEZONE', 'timezone is required');
  zoneOffsetMinutes(Date.UTC(y, m - 1, d, hh, mm), timezone); // throws INVALID_TIMEZONE if unknown

  if (calendar === 'lunar') throw new KernelError('INVALID_LUNAR_DATE', 'lunar input is not implemented');
  if (calendar !== 'solar') throw new KernelError('INVALID_CALENDAR', `unknown calendar: ${calendar}`);
  if (!['male', 'female', 'unspecified'].includes(gender)) throw new KernelError('INVALID_GENDER', `unknown gender: ${gender}`);
  if (!['midnight', 'zi-chu'].includes(dayBoundary)) throw new KernelError('INVALID_DAY_BOUNDARY', `unknown dayBoundary: ${dayBoundary}`);
  if (useTrueSolarTime) {
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new KernelError('INVALID_LONGITUDE', 'useTrueSolarTime requires longitude within -180..180');
    }
  }
  return { date, time, timezone, gender, calendar, dayBoundary, useTrueSolarTime, longitude, year: y, month: m, day: d, hour: hh, minute: mm };
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Facts
 * @property {object} input
 * @property {object} calendar
 * @property {Record<string, {stem: string, branch: string, ganzhi: string}>} fourPillars
 * @property {object} derived
 * @property {string[]} notes
 * @property {string} kernelVersion
 * @property {number} computedAt
 * @property {string[]} todos
 */

/**
 * Pure function: same input → same Facts. No clock reads, no I/O.
 * @param {BirthInput} input
 * @returns {Facts}
 */
export function computeFacts(input) {
  const n = normalizeInput(input);

  const instant = localToInstant(n.year, n.month, n.day, n.hour, n.minute, n.timezone);
  const offsetMinutes = zoneOffsetMinutes(instant, n.timezone);

  // True solar time correction: longitude offset from the zone's standard
  // meridian (4 min/degree) plus the equation of time. Applied to the *clock*
  // reading before any boundary decision, which is what "真太阳时" means.
  let trueSolarMinutes = 0;
  if (n.useTrueSolarTime) {
    trueSolarMinutes = (n.longitude - offsetMinutes / 4) * 4 + equationOfTimeMinutesAtUtc(instant);
  }
  const effective = new Date(instant + trueSolarMinutes * 60000);
  // Re-read the wall clock the corrections imply, in the same zone.
  const shifted = new Date(effective.getTime() + offsetMinutes * 60000);
  const localYear = shifted.getUTCFullYear();
  const localMonth = shifted.getUTCMonth() + 1;
  const localDay = shifted.getUTCDate();
  const localHour = shifted.getUTCHours();
  const localMinute = shifted.getUTCMinutes();

  // --- year pillar: turns at 立春 -----------------------------------------
  const lichun = lichunOf(localYear);
  const ganzhiYear = instant < lichun ? localYear - 1 : localYear;
  const yearIdx = yearCycleIndex(ganzhiYear);

  // --- month pillar: governed by the latest 節 ----------------------------
  const governed = governingJie(instant);

  // --- day pillar: continuous cycle, with the 23:00 convention -------------
  let dayYear = localYear; let dayMonth = localMonth; let dayDay = localDay;
  if (n.dayBoundary === 'zi-chu' && localHour >= 23) {
    const next = new Date(Date.UTC(localYear, localMonth - 1, localDay) + 86400000);
    dayYear = next.getUTCFullYear(); dayMonth = next.getUTCMonth() + 1; dayDay = next.getUTCDate();
  }
  const dayIdx = dayCycleIndex(dayYear, dayMonth, dayDay);

  const fourPillars = {
    year: pillarFromIndices(yearIdx, yearIdx % 12),
    month: monthPillar(yearIdx % 10, governed.term.ordinal),
    day: pillarFromIndices(dayIdx % 10, dayIdx % 12),
    hour: hourPillar(dayIdx % 10, localHour),
  };

  // --- boundary honesty ---------------------------------------------------
  const termsAround = [lichun, governed.instant];
  let nearest = null;
  for (const t of termsAround) {
    const deltaSeconds = Math.round((instant - t) / 1000);
    if (nearest === null || Math.abs(deltaSeconds) < Math.abs(nearest.deltaSeconds)) {
      nearest = { instant: t, deltaSeconds };
    }
  }
  const uncertaintyApplies = Math.abs(nearest.deltaSeconds) <= TERM_ACCURACY_SECONDS;
  const governingName = governed.term.name;
  const dstApplied = zoneOffsetMinutes(Date.UTC(localYear, 0, 15), n.timezone) !== zoneOffsetMinutes(Date.UTC(localYear, 6, 15), n.timezone);

  return {
    input: {
      date: n.date, time: n.time, timezone: n.timezone, gender: n.gender, calendar: n.calendar,
      dayBoundary: n.dayBoundary, useTrueSolarTime: n.useTrueSolarTime, longitude: n.longitude,
    },
    calendar: {
      instantUtc: new Date(instant).toISOString(),
      utcOffsetMinutes: offsetMinutes,
      dstApplied,
      localCivil: `${String(localYear).padStart(4, '0')}-${String(localMonth).padStart(2, '0')}-${String(localDay).padStart(2, '0')} ${String(localHour).padStart(2, '0')}:${String(localMinute).padStart(2, '0')}`,
      trueSolarTime: n.useTrueSolarTime,
      trueSolarCorrectionMinutes: Number(trueSolarMinutes.toFixed(2)),
      dayBoundaryConvention: n.dayBoundary === 'zi-chu' ? '23:00 (子初换日)' : '00:00 (午夜换日)',
      yearBoundary: `立春 ${new Date(lichun).toISOString()}`,
      governingTerm: { name: governingName, zh: governed.term.zh, instant: new Date(governed.instant).toISOString() },
      ganzhiYear,
      termAccuracySeconds: TERM_ACCURACY_SECONDS,
      nearestTerm: {
        name: governingName,
        instant: new Date(nearest.instant).toISOString(),
        deltaSeconds: nearest.deltaSeconds,
      },
      boundaryUncertainty: {
        applies: uncertaintyApplies,
        windowSeconds: TERM_ACCURACY_SECONDS,
        message: uncertaintyApplies
          ? `出生时刻距节气仅 ${Math.abs(nearest.deltaSeconds)} 秒，年柱或月柱可能处于换界处（本内核误差上限 ${TERM_ACCURACY_SECONDS} 秒）`
          : null,
      },
    },
    fourPillars,
    derived: { elementCounts: elementCounts(fourPillars) },
    notes: [
      `干支纪日锚点：${'1949-10-01 = 甲子日'}（外部来源见 verify/kernel-crosscheck.mjs）`,
      `年柱以立春时刻为界：${new Date(lichun).toISOString()}`,
      `月柱由最近节气「${governed.term.zh}」决定：${new Date(governed.instant).toISOString()}`,
      `时区 ${n.timezone} 偏移 ${offsetMinutes} 分钟${dstApplied ? '（该年有夏令时）' : ''}`,
      `节气算法误差上限 ${TERM_ACCURACY_SECONDS} 秒；边界命例会带 boundaryUncertainty 标记`,
    ],
    kernelVersion: 'real-1.0.0',
    computedAt: 0, // purity over convenience: the caller stamps wall-clock time
    todos: [
      '提升太阳黄经精度至 ≤60 秒（当前 ~970 秒，见 build/verify/kernel-accuracy.md）',
      '真太阳时未含历史 ΔT/时区立法变更（依赖 ICU tzdata）',
      '未实现农历输入、藏干/十神/纳音/神煞/大运',
      '时柱未知（time:null）的命盘尚未支持',
    ],
  };
}

/**
 * Renders Facts as the block handed to the model. Same shape as the stub's, so
 * the narration layer cannot tell which kernel produced it — and, more to the
 * point, the prompt contains values only, never a formula to re-derive.
 * @param {Facts} facts
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
  lines.push(`- trueSolarTime: ${facts.calendar.trueSolarTime} (${facts.calendar.trueSolarCorrectionMinutes} min)`);
  lines.push(`- dayBoundaryConvention: ${facts.calendar.dayBoundaryConvention}`);
  lines.push(`- yearBoundary: ${facts.calendar.yearBoundary}`);
  lines.push(`- governingTerm: ${facts.calendar.governingTerm.zh}`);
  lines.push(`- termAccuracySeconds: ${facts.calendar.termAccuracySeconds}`);
  lines.push(`- boundaryUncertainty: ${facts.calendar.boundaryUncertainty.applies}`);
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
  if (facts.calendar.boundaryUncertainty.applies) {
    lines.push('4. The birth time sits within the kernel\'s solar-term error window. Say so plainly:');
    lines.push('   the year or month pillar may sit on a boundary, and the user should verify the birth time.');
  }
  return lines.join('\n');
}

export default { computeFacts, normalizeInput, narrationPrompt, PILLARS, KernelError, TERM_ACCURACY_SECONDS, zoneOffsetMinutes, localToInstant };
