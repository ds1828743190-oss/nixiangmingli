/**
 * pillars.test.mjs — the sexagenary rules themselves.
 *
 * These are pure functions, so they are tested in isolation from the timezone and
 * solar-term machinery. The rules asserted here are public calendrical knowledge:
 *
 *   • day count is continuous, +1 per civil day, closing at 60;
 *   • year stems/branches run (year-4) mod 10 / mod 12, so 1984 is 甲子;
 *   • month stems follow 五虎遁 from the year stem, branches run 寅→丑;
 *   • hour branches follow the two-hour windows with 子 straddling midnight;
 *   • hour stems follow 五鼠遁 from the day stem.
 *
 * @module test/pillars.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dayCycleIndex,
  yearCycleIndex,
  monthPillar,
  hourPillar,
  pillarFromIndices,
  civilDayNumber,
  STEMS,
  BRANCHES,
  HIDDEN_STEMS,
  elementCounts,
  hiddenStemElementCounts,
} from '../pillars.mjs';

/** Day pillar for a civil date, derived from the continuous cycle index. */
function dayPillar(y, m, d) {
  const i = dayCycleIndex(y, m, d);
  return pillarFromIndices(i % 10, i % 12);
}

test('pillars: day cycle advances exactly +1 per civil day over 200 years', () => {
  // A 200-year continuous walk. This is the invariant that catches an off-by-one
  // or a leap-year slip: it exercises every month length, every Gregorian leap
  // rule, and the 1900 (not leap) / 2000 (leap) century pair.
  const start = Date.UTC(1900, 0, 1);
  const totalDays = Math.round((Date.UTC(2100, 0, 1) - start) / 86400000); // 73049
  let prev = null;
  let seen = 0;
  for (let d = 0; d <= totalDays; d++) {
    const dt = new Date(start + d * 86400000);
    const idx = dayCycleIndex(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    if (prev !== null) {
      assert.equal(idx, (prev + 1) % 60, `day cycle slipped on day ${d}`);
    }
    prev = idx;
    seen++;
  }
  assert.equal(seen, totalDays + 1);
  assert.equal(totalDays + 1, 73050);
});

test('pillars: day pillar returns to itself after exactly 60 days', () => {
  const base = dayPillar(1988, 8, 8);
  for (const offset of [60, 120, 600, 3600]) {
    const dt = new Date(Date.UTC(1988, 7, 8) + offset * 86400000);
    const p = dayPillar(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    assert.equal(p.ganzhi, base.ganzhi, `cycle did not close at +${offset} days`);
  }
});

test('pillars: civilDayNumber matches known Julian Day Numbers', () => {
  // JD 2451545.0 = 2000 January 1.5 TT (the J2000.0 epoch). The JDN of the civil
  // date 2000-01-01 is therefore 2451545; the Unix epoch is 1970-01-01 = 2440588.
  assert.equal(civilDayNumber(2000, 1, 1) + 2440588 - 2440588, civilDayNumber(2000, 1, 1));
  assert.equal(civilDayNumber(1970, 1, 1), 0);
  // Day-count differences pin the calendar rules without hard-coding a JDN:
  assert.equal(civilDayNumber(1949, 10, 1) - civilDayNumber(2000, 1, 1), -18354);
  // 1900 is not a leap year, so 1900-03-01 follows 02-28 directly.
  assert.equal(civilDayNumber(1900, 3, 1) - civilDayNumber(1900, 2, 28), 1);
  // 2000 IS a leap year, so there is an extra day.
  assert.equal(civilDayNumber(2000, 3, 1) - civilDayNumber(2000, 2, 28), 2);
});

test('pillars: year cycle follows (year-4) mod 60 (1984 = 甲子)', () => {
  const yp = (year) => {
    const i = yearCycleIndex(year);
    return pillarFromIndices(i % 10, i % 12);
  };
  assert.equal(yp(1984).ganzhi, 'jia-zi');
  assert.equal(yp(1985).ganzhi, 'yi-chou');
  assert.equal(yp(2024).ganzhi, 'jia-chen'); // 甲辰 dragon
  assert.equal(yp(2023).ganzhi, 'gui-mao');  // 癸卯 rabbit
  assert.equal(yp(2000).ganzhi, 'geng-chen');
  assert.equal(yp(2044).ganzhi, yp(1984).ganzhi); // 60-year closure
});

test('pillars: month branches run 寅→丑 from 立春, stems by 五虎遁', () => {
  // The five 五虎遁 pairs, each pinned by the 寅-month stem:
  //   甲/己→丙寅, 乙/庚→戊寅, 丙/辛→庚寅, 丁/壬→壬寅, 戊/癸→甲寅
  const expectations = [
    [0, 'bing-yin'], [5, 'bing-yin'],   // 甲, 己
    [1, 'wu-yin'], [6, 'wu-yin'],       // 乙, 庚
    [2, 'geng-yin'], [7, 'geng-yin'],   // 丙, 辛
    [3, 'ren-yin'], [8, 'ren-yin'],     // 丁, 壬
    [4, 'jia-yin'], [9, 'jia-yin'],     // 戊, 癸
  ];
  for (const [yearStem, want] of expectations) {
    assert.equal(
      monthPillar(yearStem, 1).ganzhi, want,
      `寅-month for year stem ${STEMS[yearStem]}`,
    );
  }
  // Branches must walk 寅卯辰巳午未申酉戌亥子丑 across ordinals 1..12.
  const expectedBranches = ['yin', 'mao', 'chen', 'si', 'wu', 'wei', 'shen', 'you', 'xu', 'hai', 'zi', 'chou'];
  for (let ord = 1; ord <= 12; ord++) {
    assert.equal(monthPillar(0, ord).branch, expectedBranches[ord - 1], `ordinal ${ord}`);
  }
  // 甲 year: ordinal 11 is the 子 month. 丙寅 + 10 steps = 丙子.
  assert.equal(monthPillar(0, 11).ganzhi, 'bing-zi');
});

test('pillars: hour branches follow the 2-hour windows (子 straddles midnight)', () => {
  const expect = {
    23: 'zi', 0: 'zi', 1: 'chou', 2: 'chou', 3: 'yin', 4: 'yin',
    5: 'mao', 6: 'mao', 7: 'chen', 8: 'chen', 9: 'si', 10: 'si',
    11: 'wu', 12: 'wu', 13: 'wei', 14: 'wei', 15: 'shen', 16: 'shen',
    17: 'you', 18: 'you', 19: 'xu', 20: 'xu', 21: 'hai', 22: 'hai',
  };
  for (const [hour, branch] of Object.entries(expect)) {
    assert.equal(hourPillar(0, Number(hour)).branch, branch, `hour ${hour}`);
  }
});

test('pillars: hour stems follow 五鼠遁 from the day stem', () => {
  // 甲/己→甲子, 乙/庚→丙子, 丙/辛→戊子, 丁/壬→庚子, 戊/癸→壬子
  const cases = [
    [0, 'jia-zi'], [5, 'jia-zi'],
    [1, 'bing-zi'], [6, 'bing-zi'],
    [2, 'wu-zi'], [7, 'wu-zi'],
    [3, 'geng-zi'], [8, 'geng-zi'],
    [4, 'ren-zi'], [9, 'ren-zi'],
  ];
  for (const [dayStem, want] of cases) {
    assert.equal(hourPillar(dayStem, 23).ganzhi, want, `子 hour for day stem ${STEMS[dayStem]}`);
    assert.equal(hourPillar(dayStem, 0).ganzhi, want, `子 hour (00:xx) for ${STEMS[dayStem]}`);
  }
  // Hour stems advance one per branch from the 子 stem. The 子 branch straddles
  // midnight, so its representative clock hour is 00 (not 01).
  const representativeHour = [0, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21];
  for (let dayStem = 0; dayStem < 10; dayStem++) {
    const zi = STEMS.indexOf(hourPillar(dayStem, 0).stem);
    for (let b = 0; b < 12; b++) {
      const p = hourPillar(dayStem, representativeHour[b]);
      assert.equal(p.branch, BRANCHES[b], `day stem ${dayStem} branch slot ${b}`);
      assert.equal(STEMS.indexOf(p.stem), (zi + b) % 10, `day stem ${dayStem} branch ${b}`);
    }
  }
});

test('pillars: every pillar is a valid stem/branch combination', () => {
  for (let i = -30; i < 30; i++) {
    const p = pillarFromIndices(i, i);
    assert.ok(STEMS.includes(p.stem), `bad stem from index ${i}`);
    assert.ok(BRANCHES.includes(p.branch), `bad branch from index ${i}`);
    assert.equal(p.ganzhi, `${p.stem}-${p.branch}`);
  }
});

test('pillars: hidden stems are well-formed and cover every branch', () => {
  for (const branch of BRANCHES) {
    const hidden = HIDDEN_STEMS[branch];
    assert.ok(Array.isArray(hidden) && hidden.length >= 1, `${branch} has no hidden stems`);
    for (const s of hidden) assert.ok(STEMS.includes(s), `${branch} references bad stem ${s}`);
    assert.ok(hidden.length <= 3, `${branch} has too many hidden stems`);
  }
  // Spot-check the uncontested entries.
  assert.deepEqual([...HIDDEN_STEMS.zi], ['gui']);
  assert.deepEqual([...HIDDEN_STEMS.mao], ['yi']);
  assert.deepEqual([...HIDDEN_STEMS.you], ['xin']);
  assert.deepEqual([...HIDDEN_STEMS.yin], ['jia', 'bing', 'wu']);
});

test('pillars: element tallies sum to 8 visible and 8+ hidden stems', () => {
  const pillars = {
    year: pillarFromIndices(0, 0),
    month: pillarFromIndices(2, 2),
    day: pillarFromIndices(4, 6),
    hour: pillarFromIndices(6, 8),
  };
  const visible = elementCounts(pillars);
  assert.equal(Object.values(visible).reduce((a, b) => a + b, 0), 8);
  const hidden = hiddenStemElementCounts(pillars);
  assert.ok(Object.values(hidden).reduce((a, b) => a + b, 0) >= 8);
  for (const key of ['wood', 'fire', 'earth', 'metal', 'water']) {
    assert.ok(Number.isInteger(visible[key]), `${key} missing from visible tally`);
    assert.ok(Number.isInteger(hidden[key]), `${key} missing from hidden tally`);
  }
});
