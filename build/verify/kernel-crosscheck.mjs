/**
 * kernel-crosscheck.mjs — independent verification of build/kernel.
 *
 * This file exists because the day-pillar anchor is the single constant that can
 * silently corrupt every chart. It does NOT reuse any table or constant from the
 * kernel under test: the expected values below come from external sources, and
 * the arithmetic that ties them together is written out here.
 *
 * Sources (both public, independent of each other):
 *
 *  S1. Zenodo dataset "中国历法公共数据集" (CC BY 4.0), asset A3 — sexagenary day
 *      correspondence 1900–2052, 55,883 days: anchored on
 *      **1 October 1949 = 甲子日**, described there as "three sources agreeing",
 *      and cross-checked by its author against four modern records plus the
 *      Chunqiu entry for 720 BCE.
 *      https://zenodo.org/records/22820072
 *
 *  S2. Almanac page for 2000-01-01 (D777 老黄历):
 *      https://nongli.d777.com/2000-1-1
 *      gives 己卯年 丙子月 戊午日, and a per-时辰 table with the full 八字:
 *      子时 壬子 · 丑时 癸丑 · 寅时 甲寅 · 卯时 乙卯 · 辰时 丙辰 · 巳时 丁巳 ·
 *      午时 戊午 · 未时 己未 · 申时 庚申 · 酉时 辛酉 · 戌时 壬戌 · 亥时 癸亥.
 *
 * Tie-out done by hand (no kernel code involved):
 *   1949-10-01 (index 0) -> 2000-01-01 is 18354 days.
 *   51 years x 365 + 13 leap days = 18628 days to 2000-10-01; minus 274 days
 *   (Jan..Sep 2000 in a leap year) = 18354.   18354 mod 60 = 54.
 *   index 54 -> stem 54 mod 10 = 4 -> 戊 ; branch 54 mod 12 = 6 -> 午  => 戊午.
 *   S2 independently says 戊午 for that date. The two anchors agree.
 *
 * S2 also pins rules the anchors alone do not:
 *   - year pillar is 己卯 (not 庚辰): 2000-01-01 precedes 立春, so the year has
 *     not turned. A kernel that switches at Jan 1 fails this.
 *   - month pillar is 丙子 for a 己 year (五虎遁 甲/己 -> 寅月丙, counted 寅..子),
 *     which validates the month-stem rule, not just the branch.
 *   - hour stems for a 戊 day (五鼠遁 戊/癸 -> 子时壬) validate the hour rule.
 *
 * Run:  "$NODE" build/verify/kernel-crosscheck.mjs
 * Exit 0 = all anchors reproduce. Exit 2 = kernel not implemented yet.
 *
 * @module kernel-crosscheck
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KERNEL_ENTRY = path.resolve(HERE, '..', 'kernel', 'index.mjs');

/**
 * @typedef {object} Anchor
 * @property {string} label
 * @property {string} date
 * @property {string} time
 * @property {string} timezone
 * @property {{year?: string, month?: string, day?: string, hour?: string}} expect
 * @property {string} source
 */

/** @type {Anchor[]} */
export const ANCHORS = [
  {
    label: 'A3 anchor: PRC founding day is a jia-zi day',
    date: '1949-10-01',
    time: '12:00',
    timezone: 'Asia/Shanghai',
    expect: { day: 'jia-zi' },
    source: 'S1 zenodo:22820072 (A3, three sources agreeing)',
  },
  {
    label: 'almanac: 2000-01-01 day pillar',
    date: '2000-01-01',
    time: '12:00',
    timezone: 'Asia/Shanghai',
    expect: { day: 'wu-wu' },
    source: 'S2 nongli.d777.com/2000-1-1',
  },
  {
    label: 'almanac: 2000-01-01 year/month (pre-立春, so still 己卯 / 丙子)',
    date: '2000-01-01',
    time: '12:00',
    timezone: 'Asia/Shanghai',
    expect: { year: 'ji-mao', month: 'bing-zi' },
    source: 'S2 nongli.d777.com/2000-1-1',
  },
  {
    label: 'almanac: hour stem for a 戊 day at 子时 (五鼠遁 戊/癸 -> 子时壬)',
    date: '2000-01-01',
    time: '23:00',
    timezone: 'Asia/Shanghai',
    expect: { day: 'wu-wu', hour: 'ren-zi' },
    source: 'S2 nongli.d777.com/2000-1-1 (时辰 table)',
  },
  {
    label: 'almanac: hour stem for a 戊 day at 巳时',
    date: '2000-01-01',
    time: '09:30',
    timezone: 'Asia/Shanghai',
    expect: { day: 'wu-wu', hour: 'ding-si' },
    source: 'S2 nongli.d777.com/2000-1-1 (时辰 table)',
  },
  {
    label: 'almanac: hour stem for a 戊 day at 亥时',
    date: '2000-01-01',
    time: '21:30',
    timezone: 'Asia/Shanghai',
    expect: { day: 'wu-wu', hour: 'gui-hai' },
    source: 'S2 nongli.d777.com/2000-1-1 (时辰 table)',
  },
];

const results = [];
/** @param {string} name @param {boolean} ok @param {string} detail */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Solar-term accuracy, against a published table (see kernel-accuracy.md)
// ---------------------------------------------------------------------------

/**
 * Published solar-term instants, Beijing time (UTC+8), second precision.
 * Source: 日历网《二十四节气对应时间表 2020–2035》
 * https://m.rili.com.cn/24jieqi/71169.html
 * `[longitudeDeg, year, month, day, hh, mm, ss]`
 */
export const PUBLISHED_TERMS = [
  [315, 2020, 2, 4, 17, 3, 12], [315, 2021, 2, 3, 22, 58, 39], [315, 2022, 2, 4, 4, 50, 36],
  [315, 2023, 2, 4, 10, 42, 21], [315, 2024, 2, 4, 16, 26, 53], [315, 2025, 2, 3, 22, 10, 13],
  [315, 2026, 2, 4, 4, 1, 51], [315, 2027, 2, 4, 9, 46, 0], [315, 2028, 2, 4, 15, 30, 53],
  [315, 2029, 2, 3, 21, 20, 25], [315, 2030, 2, 4, 3, 8, 4],
  [345, 2024, 3, 5, 10, 22, 31], [15, 2024, 4, 4, 15, 2, 3], [135, 2024, 8, 7, 8, 9, 1],
  [225, 2024, 11, 7, 6, 19, 49], [255, 2024, 12, 6, 23, 16, 47], [285, 2025, 1, 5, 10, 32, 31],
];

/** Tolerance in minutes. The product needs the boundary minute to be right. */
const TERM_TOLERANCE_MIN = 2;

/**
 * Audits the astronomy layer if it is present. Kept separate from the pillar
 * checks so a partially built kernel still produces an honest accuracy number.
 */
async function auditSolarTerms() {
  // Audit the module that ACTUALLY supplies term instants. `astro-vsop87.mjs`
  // replaced the compact Kepler approximation, so testing astro.mjs after that
  // swap would measure a module the product no longer uses — a green gate on
  // dead code is worse than no gate.
  const candidates = ['astro-vsop87.mjs', 'astro.mjs'];
  let astro = null;
  let audited = null;
  for (const name of candidates) {
    const p = path.resolve(HERE, '..', 'kernel', name);
    if (!fs.existsSync(p)) continue;
    const mod = await import(pathToFileURL(p).href);
    if (typeof mod.solarTermInstant === 'function') { astro = mod; audited = name; break; }
  }
  if (!astro) {
    check('a solar-term implementation is present to audit', false, 'no candidate exported solarTermInstant');
    return;
  }
  check('the audited module is the one the kernel actually uses',
    audited === 'astro-vsop87.mjs',
    `audited=${audited}${audited === 'astro.mjs' ? ' (compact approximation — expected only as a fallback)' : ''}`);
  let worst = 0;
  let worstAt = '';
  const lines = [];
  for (const [deg, y, mo, d, h, mi, s] of PUBLISHED_TERMS) {
    const want = Date.UTC(y, mo - 1, d, h - 8, mi, s);
    // Bracket deliberately: a guess outside the term's neighbourhood can snap to
    // a DIFFERENT year's occurrence and look like a one-year error.
    const got = astro.solarTermInstant(deg, Date.UTC(y, mo - 1, 1), 20);
    const errMin = (got - want) / 60000;
    if (Math.abs(errMin) > worst) { worst = Math.abs(errMin); worstAt = `${deg}° ${y}-${mo}-${d}`; }
    lines.push(`${deg}°/${y}:${errMin.toFixed(1)}`);
  }
  check(`solar-term instants match the published table within ${TERM_TOLERANCE_MIN} min`,
    worst <= TERM_TOLERANCE_MIN,
    `max |error| = ${worst.toFixed(1)} min at ${worstAt} · ${lines.slice(0, 6).join(' ')} …`);

  // The gate that protects users TODAY, independent of the target above: the
  // kernel's published `termAccuracySeconds` must actually cover its measured
  // error. If it claimed 2 min while erring 8 min, every boundary case inside
  // that gap would be silently resolved the wrong way — the one failure mode
  // this whole architecture is built to prevent. An understated window is a
  // worse bug than a large window.
  try {
    const idx = await import(pathToFileURL(path.resolve(HERE, '..', 'kernel', 'index.mjs')).href);
    const stated = idx.TERM_ACCURACY_SECONDS;
    const measuredMaxSeconds = worst * 60;
    check('the stated accuracy window covers the measured error (no understatement)',
      Number.isInteger(stated) && stated >= measuredMaxSeconds,
      `stated=${stated}s measuredMax=${measuredMaxSeconds.toFixed(0)}s`);
  } catch (err) {
    check('the stated accuracy window covers the measured error (no understatement)', false,
      `could not read TERM_ACCURACY_SECONDS: ${err.message}`);
  }
}

/** @param {string} s */
function fmt(p) {
  return p ? p.ganzhi : 'n/a';
}

async function main() {
  if (!fs.existsSync(KERNEL_ENTRY)) {
    // The astronomy layer may exist before the pillar layer does; audit it anyway.
    await auditSolarTerms();
    console.log(`kernel not implemented yet: ${KERNEL_ENTRY} is absent (pillar checks skipped)`);
    const failedEarly = results.filter((r) => !r.ok);
    process.exit(failedEarly.length ? 1 : 2);
  }
  await auditSolarTerms();
  const { computeFacts } = await import(pathToFileURL(KERNEL_ENTRY).href);

  // --- external anchors -------------------------------------------------
  for (const a of ANCHORS) {
    let facts;
    try {
      facts = computeFacts({ date: a.date, time: a.time, timezone: a.timezone });
    } catch (err) {
      check(a.label, false, `threw: ${err.message}`);
      continue;
    }
    const got = {
      year: fmt(facts.fourPillars?.year),
      month: fmt(facts.fourPillars?.month),
      day: fmt(facts.fourPillars?.day),
      hour: fmt(facts.fourPillars?.hour),
    };
    const bad = Object.entries(a.expect).filter(([k, v]) => got[k] !== v);
    check(a.label, bad.length === 0,
      bad.length
        ? `expected ${bad.map(([k, v]) => `${k}=${v}`).join(' ')} · got ${bad.map(([k]) => `${k}=${got[k]}`).join(' ')}`
        : `${a.date} ${a.time} → ${Object.entries(a.expect).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }

  // --- structural invariants (independent of any table) -----------------
  const idx = new Map();
  const dayIndex = (ganzhi) => {
    if (!idx.has('table')) {
      const stems = ['jia', 'yi', 'bing', 'ding', 'wu', 'ji', 'geng', 'xin', 'ren', 'gui'];
      const branches = ['zi', 'chou', 'yin', 'mao', 'chen', 'si', 'wu', 'wei', 'shen', 'you', 'xu', 'hai'];
      const t = new Map();
      for (let i = 0; i < 60; i += 1) t.set(`${stems[i % 10]}-${branches[i % 12]}`, i);
      idx.set('table', t);
    }
    return idx.get('table').get(ganzhi);
  };

  // 1) consecutive civil days advance exactly +1 in the cycle, mod 60, over ~5 years
  let cursor = Date.UTC(1995, 0, 1);
  let prev = null;
  let advanceOk = true;
  let advanceDetail = '';
  for (let i = 0; i < 1827; i += 1) {
    const d = new Date(cursor + i * 86400000);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const facts = computeFacts({ date, time: '12:00', timezone: 'UTC' });
    const now = dayIndex(fmt(facts.fourPillars?.day));
    if (prev !== null && (prev + 1) % 60 !== now) {
      advanceOk = false;
      advanceDetail = `breaks at ${date}: ${prev} -> ${now}`;
      break;
    }
    prev = now;
  }
  check('day pillar advances exactly +1 per civil day for 5 years (mod 60)', advanceOk, advanceDetail);

  // 2) the four-pillar month must be one of the 12 month branches, and the
  //    hour branch must be consistent with the clock window
  const hourWindows = [
    ['23:00', 'zi'], ['00:30', 'zi'], ['02:30', 'chou'], ['04:30', 'yin'],
    ['06:30', 'mao'], ['08:30', 'chen'], ['10:30', 'si'], ['12:30', 'wu'],
    ['14:30', 'wei'], ['16:30', 'shen'], ['18:30', 'you'], ['20:30', 'xu'],
    ['22:30', 'hai'],
  ];
  const hourBad = [];
  for (const [time, branch] of hourWindows) {
    const facts = computeFacts({ date: '2020-06-15', time, timezone: 'UTC' });
    const got = facts.fourPillars?.hour?.branch;
    if (got !== branch) hourBad.push(`${time}→${got} (want ${branch})`);
  }
  check('hour branch follows the 2-hour windows at 13 sampled times', hourBad.length === 0, hourBad.join(', '));

  // 3) year pillar must NOT turn at Jan 1 (it turns at 立春)
  const jan = computeFacts({ date: '2021-01-15', time: '12:00', timezone: 'UTC' });
  const afterLichun = computeFacts({ date: '2021-03-01', time: '12:00', timezone: 'UTC' });
  check('year pillar differs across 立春 but is unchanged from Dec to Jan',
    jan.fourPillars?.year?.ganzhi === computeFacts({ date: '2020-12-15', time: '12:00', timezone: 'UTC' }).fourPillars?.year?.ganzhi
    && afterLichun.fourPillars?.year?.ganzhi !== jan.fourPillars?.year?.ganzhi,
    `2020-12=${jan.fourPillars?.year?.ganzhi} 2021-01=${jan.fourPillars?.year?.ganzhi} 2021-03=${afterLichun.fourPillars?.year?.ganzhi}`);

  // 4) purity: same input -> byte-identical facts
  const a = JSON.stringify(computeFacts({ date: '1988-08-08', time: '08:08', timezone: 'Asia/Shanghai' }));
  const b = JSON.stringify(computeFacts({ date: '1988-08-08', time: '08:08', timezone: 'Asia/Shanghai' }));
  check('computeFacts is pure (identical output for identical input)', a === b);

  // --- boundary behaviour (where a correct kernel and a sloppy one differ) ---
  const dayOf = (f) => f.fourPillars?.day?.ganzhi;
  const yearOf = (f) => f.fourPillars?.year?.ganzhi;
  const hourOf = (f) => f.fourPillars?.hour?.ganzhi;

  // 立春 2024 = 2024-02-04 16:26:53 CST (published; see kernel-accuracy.md).
  // One minute either side of it must land in different sexagenary YEARS:
  // 2023 = 癸卯, 2024 = 甲辰. A kernel that switches at Jan 1 fails both halves.
  const before = computeFacts({ date: '2024-02-04', time: '16:25', timezone: 'Asia/Shanghai' });
  const after = computeFacts({ date: '2024-02-04', time: '16:28', timezone: 'Asia/Shanghai' });
  check('year pillar turns at 立春, not at Jan 1 (1 min either side of the published instant)',
    yearOf(before) === 'gui-mao' && yearOf(after) === 'jia-chen',
    `16:25 -> ${yearOf(before)} (want gui-mao) · 16:28 -> ${yearOf(after)} (want jia-chen)`);

  // Month pillar must turn at the same instant.
  const monthBefore = computeFacts({ date: '2024-02-04', time: '16:25', timezone: 'Asia/Shanghai' });
  const monthAfter = computeFacts({ date: '2024-02-04', time: '16:28', timezone: 'Asia/Shanghai' });
  check('month pillar also turns at the 节 instant',
    monthBefore.fourPillars?.month?.ganzhi !== monthAfter.fourPillars?.month?.ganzhi,
    `16:25 -> ${monthBefore.fourPillars?.month?.ganzhi} · 16:28 -> ${monthAfter.fourPillars?.month?.ganzhi}`);

  // Day-boundary convention: 23:30 on 2000-01-01 is 戊午 under midnight-reset and
  // already 己未 under the 子初 (23:00) convention. Both must be selectable, and
  // the difference must be exactly one day in the cycle.
  const at2330 = { date: '2000-01-01', time: '23:30', timezone: 'Asia/Shanghai' };
  const midnight = computeFacts({ ...at2330, dayBoundary: 'midnight' });
  const zichu = computeFacts({ ...at2330, dayBoundary: 'zi-chu' });
  check('23:00 day-boundary convention is selectable and advances exactly one day',
    dayOf(midnight) === 'wu-wu' && dayOf(zichu) === 'ji-wei',
    `midnight -> ${dayOf(midnight)} (want wu-wu) · zi-chu -> ${dayOf(zichu)} (want ji-wei)`);

  // Hour boundary at 23:00: 亥 -> 子, with the 五鼠遁 stem for a 戊 day.
  const h2259 = computeFacts({ date: '2000-01-01', time: '22:59', timezone: 'Asia/Shanghai' });
  const h2301 = computeFacts({ date: '2000-01-01', time: '23:01', timezone: 'Asia/Shanghai' });
  check('hour branch turns at 23:00 (亥 -> 子) with the correct 五鼠遁 stems',
    hourOf(h2259) === 'gui-hai' && hourOf(h2301) === 'ren-zi',
    `22:59 -> ${hourOf(h2259)} (want gui-hai) · 23:01 -> ${hourOf(h2301)} (want ren-zi)`);

  // --- honesty about precision: a birth within the kernel's own error window of
  // a 節 MUST be flagged instead of silently resolved, and a birth outside it must
  // not be. 2024 立春 is 16:26:53 CST, so 16:26 is ~53 s inside, and 2024-06-15 is
  // far outside. Both are checked independently of the precision gate above.
  const nearBoundary = computeFacts({ date: '2024-02-04', time: '16:26', timezone: 'Asia/Shanghai' });
  const farFromBoundary = computeFacts({ date: '2024-06-15', time: '12:00', timezone: 'Asia/Shanghai' });
  check('a birth inside the stated term-error window is flagged as uncertain',
    nearBoundary.calendar?.boundaryUncertainty?.applies === true
    && typeof nearBoundary.calendar.boundaryUncertainty.message === 'string',
    `applies=${nearBoundary.calendar?.boundaryUncertainty?.applies} delta=${nearBoundary.calendar?.nearestTerm?.deltaSeconds}s window=${nearBoundary.calendar?.termAccuracySeconds}s`);
  check('a birth far from any boundary is NOT flagged (no crying wolf)',
    farFromBoundary.calendar?.boundaryUncertainty?.applies === false,
    `applies=${farFromBoundary.calendar?.boundaryUncertainty?.applies} delta=${farFromBoundary.calendar?.nearestTerm?.deltaSeconds}s`);
  const stated = nearBoundary.calendar?.termAccuracySeconds;
  check('the stated accuracy is a real measurement, not a padded or zeroed number',
    Number.isInteger(stated) && stated >= 5 && stated <= 300,
    `termAccuracySeconds=${stated}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} cross-checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(`  - ${f.name} (${f.detail})`);
    process.exit(1);
  }
  console.log('CROSSCHECK: PASS');
}

main().catch((err) => { console.error('harness error:', err); process.exit(3); });
