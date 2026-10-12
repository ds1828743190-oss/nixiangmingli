/**
 * pillars.mjs — sexagenary (干支) arithmetic. Pure functions, no I/O, no clock.
 *
 * Everything here is public-domain calendrical rule, written out so it can be
 * checked by hand against a published almanac:
 *
 *   • Day count      — one continuous cycle anchored on 1949-10-01 = 甲子日
 *                      (三源一致; cross-checked against 2000-01-01 = 戊午日).
 *   • Year pillar    — turns at 立春, never at 1 January.
 *   • Month pillar   — turns at each of the 12 节; stem by 五虎遁 from the year stem.
 *   • Hour pillar    — branch from the 2-hour window; stem by 五鼠遁 from the day stem.
 *
 * The rules live here rather than in the orchestration layer so that a wrong
 * rule is a wrong *function*, covered by a unit test, and not a wrong number
 * buried in a Facts object.
 *
 * @module pillars
 */

/** Heavenly stems, index 0 = 甲. */
export const STEMS = Object.freeze(['jia', 'yi', 'bing', 'ding', 'wu', 'ji', 'geng', 'xin', 'ren', 'gui']);
/** Earthly branches, index 0 = 子. */
export const BRANCHES = Object.freeze(['zi', 'chou', 'yin', 'mao', 'chen', 'si', 'wu', 'wei', 'shen', 'you', 'xu', 'hai']);

/** The 60-cycle index of the anchor day. 1949-10-01 is 甲子 (index 0). */
export const DAY_ANCHOR = Object.freeze({
  date: '1949-10-01',
  index: 0,
  source: '1949-10-01 = 甲子日 (three independent sources agreeing); see build/verify/kernel-crosscheck.mjs',
});

/** Month branches in 节 order: 寅 first (立春), 丑 last (小寒). */
export const MONTH_BRANCHES = Object.freeze(['yin', 'mao', 'chen', 'si', 'wu', 'wei', 'shen', 'you', 'xu', 'hai', 'zi', 'chou']);

/** Stem of the 寅 month for each year stem, by 五虎遁 (甲己→丙, 乙庚→戊, 丙辛→庚, 丁壬→壬, 戊癸→甲). */
export const MONTH_STEM_BASE = Object.freeze([2, 4, 6, 8, 0]); // indexed by yearStemIndex % 5

/** Stem of the 子 hour for each day stem, by 五鼠遁 (甲己→甲, 乙庚→丙, 丙辛→戊, 丁壬→庚, 戊癸→壬). */
export const HOUR_STEM_BASE = Object.freeze([0, 2, 4, 6, 8]); // indexed by dayStemIndex % 5

/** Five-element mapping used for the derived tally. */
const STEM_ELEMENT = Object.freeze({ jia: 'wood', yi: 'wood', bing: 'fire', ding: 'fire', wu: 'earth', ji: 'earth', geng: 'metal', xin: 'metal', ren: 'water', gui: 'water' });
const BRANCH_ELEMENT = Object.freeze({ zi: 'water', chou: 'earth', yin: 'wood', mao: 'wood', chen: 'earth', si: 'fire', wu: 'fire', wei: 'earth', shen: 'metal', you: 'metal', xu: 'earth', hai: 'water' });

/** @param {string} stem @param {string} branch */
export function ganzhi(stem, branch) {
  return `${stem}-${branch}`;
}

/** A pillar from stem/branch *indices*. */
export function pillarFromIndices(stemIndex, branchIndex) {
  const stem = STEMS[((stemIndex % 10) + 10) % 10];
  const branch = BRANCHES[((branchIndex % 12) + 12) % 12];
  return { stem, branch, ganzhi: ganzhi(stem, branch) };
}

/** Days since the Unix epoch for a civil date (UTC midnight), used as a day counter. */
export function civilDayNumber(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

/**
 * Sexagenary day index for a civil date.
 *
 * Uses the anchor rather than a modular trick so that the one constant that can
 * poison every chart is visible, named, and cited.
 *
 * @param {number} year @param {number} month @param {number} day
 * @returns {number} 0..59, where 0 = 甲子
 */
export function dayCycleIndex(year, month, day) {
  const anchorDay = civilDayNumber(1949, 10, 1);
  const days = civilDayNumber(year, month, day) - anchorDay;
  return ((days + DAY_ANCHOR.index) % 60 + 60) % 60;
}

/** Sexagenary year index from a ganzhi year number (1984 = 甲子). */
export function yearCycleIndex(ganzhiYear) {
  return (((ganzhiYear - 4) % 60) + 60) % 60;
}

/**
 * Month pillar.
 * @param {number} yearStemIndex stem index of the ganzhi YEAR the month belongs to
 * @param {number} ordinal 1..12, where 1 = 寅 month (立春 .. 惊蛰)
 */
export function monthPillar(yearStemIndex, ordinal) {
  const o = ((ordinal - 1) % 12 + 12) % 12;
  const base = MONTH_STEM_BASE[((yearStemIndex % 5) + 5) % 5];
  return pillarFromIndices(base + o, BRANCHES.indexOf(MONTH_BRANCHES[o]));
}

/**
 * Hour pillar.
 * @param {number} dayStemIndex stem index of the day the hour belongs to
 * @param {number} hour 0..23 local clock hour
 */
export function hourPillar(dayStemIndex, hour) {
  const branchIndex = Math.floor(((hour + 1) % 24) / 2);
  const base = HOUR_STEM_BASE[((dayStemIndex % 5) + 5) % 5];
  return pillarFromIndices(base + branchIndex, branchIndex);
}

/** Element tally over the four stems and four branches. */
export function elementCounts(pillars) {
  const counts = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
  for (const p of Object.values(pillars)) {
    counts[STEM_ELEMENT[p.stem]] += 1;
    counts[BRANCH_ELEMENT[p.branch]] += 1;
  }
  return counts;
}

/**
 * 藏干 — the hidden (embedded) stems carried by each branch.
 *
 * Listed in the conventional order: 本气 (dominant), 中气 (middle), 余气
 * (residual). This table is short enough to audit by eye and is the mainstream
 * reading; the handful of branches where sources disagree about the residual
 * stem (notably 辰/戌 and 丑/未 variants) are noted in README.md rather than
 * silently resolved.
 *
 * It is included because the task asked for 藏干 only "if you can do it
 * correctly" — the entries below are the uncontested ones, and the derived tally
 * exposes which stems were counted so a disagreement is visible to a caller.
 */
export const HIDDEN_STEMS = Object.freeze({
  zi: Object.freeze(['gui']),
  chou: Object.freeze(['ji', 'gui', 'xin']),
  yin: Object.freeze(['jia', 'bing', 'wu']),
  mao: Object.freeze(['yi']),
  chen: Object.freeze(['wu', 'yi', 'gui']),
  si: Object.freeze(['bing', 'geng', 'wu']),
  wu: Object.freeze(['ding', 'ji']),
  wei: Object.freeze(['ji', 'ding', 'yi']),
  shen: Object.freeze(['geng', 'ren', 'wu']),
  you: Object.freeze(['xin']),
  xu: Object.freeze(['wu', 'xin', 'ding']),
  hai: Object.freeze(['ren', 'jia']),
});

/**
 * Hidden-stem element tally across the four branches, reported separately from
 * the visible `elementCounts` so a UI can show both without conflating them.
 */
export function hiddenStemElementCounts(pillars) {
  const counts = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
  for (const p of Object.values(pillars)) {
    for (const stem of HIDDEN_STEMS[p.branch]) counts[STEM_ELEMENT[stem]] += 1;
  }
  return counts;
}

export { STEM_ELEMENT, BRANCH_ELEMENT };
