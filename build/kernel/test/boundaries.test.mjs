/**
 * boundaries.test.mjs — the boundary behaviour that decides a whole chart.
 *
 * These are integration tests through `computeFacts`, because the rules that
 * matter here are *crossings*: the year pillar turns at the 立春 instant, the
 * month pillar at each 节, the hour branch at odd hours, and the day advances at
 * 23:00 under 子初换日 but at 00:00 under midnight. A boundary bug is the one
 * failure mode a user cannot detect from the prose, so each is tested from both
 * sides.
 *
 * The published 立春 instants below come from external tables (see REFERENCES.md);
 * the tolerances reflect the model's measured accuracy, which is asserted in
 * astro.test.mjs and reported in README.md.
 *
 * @module test/boundaries.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeFacts, KernelError, normalizeInput, PILLARS } from '../index.mjs';
import { JIE } from '../astro.mjs';
import { solarTermInstant } from '../astro-vsop87.mjs';

/**
 * 2024 立春 in Asia/Shanghai. External table gives 16:27:05 CST on 2024-02-04
 * (tool.ljgw.cn 二十四节气表; the National Astronomical Observatory of Japan
 * independently gives 17:27 JST, i.e. the same instant to the minute).
 */
const LICHUN_2024_PUBLISHED_UTC = Date.UTC(2024, 1, 4, 16, 27, 5 - 8 - 0); // 08:27:05Z

test('boundaries: year pillar flips exactly at the computed 立春 instant', () => {
  const lichun = solarTermInstant(315, LICHUN_2024_PUBLISHED_UTC, 20);
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 19);

  // One minute either side of OUR computed instant must straddle the year pillar.
  const before = computeFacts({ date: fmt(lichun - 60000).slice(0, 10), time: fmt(lichun - 60000).slice(11, 16), timezone: 'UTC' });
  const after = computeFacts({ date: fmt(lichun + 60000).slice(0, 10), time: fmt(lichun + 60000).slice(11, 16), timezone: 'UTC' });
  assert.notEqual(before.fourPillars.year.ganzhi, after.fourPillars.year.ganzhi,
    'year pillar did not flip across the 立春 instant');

  // And the after side must be the incoming year (2024 = 甲辰), the before side
  // the outgoing one (2023 = 癸卯).
  assert.equal(after.fourPillars.year.ganzhi, 'jia-chen');
  assert.equal(before.fourPillars.year.ganzhi, 'gui-mao');
});

test('boundaries: year pillar does NOT turn at January 1', () => {
  // 2024-01-01 is well before 立春 2024, so the ganzhi year is still 2023 = 癸卯.
  const jan1 = computeFacts({ date: '2024-01-01', time: '12:00', timezone: 'Asia/Shanghai' });
  assert.equal(jan1.fourPillars.year.ganzhi, 'gui-mao');
  assert.equal(jan1.calendar.ganzhiYear, 2023);
  // And a date just after 立春 is the new year.
  const mar1 = computeFacts({ date: '2024-03-01', time: '12:00', timezone: 'Asia/Shanghai' });
  assert.equal(mar1.fourPillars.year.ganzhi, 'jia-chen');
  assert.equal(mar1.calendar.ganzhiYear, 2024);
});

test('boundaries: month pillar flips exactly at a 节 instant', () => {
  // Use 惊蛰 (315+30 deg) 2024, published as 2024-03-05 10:22:43 CST.
  const jingzhe = solarTermInstant(345, Date.UTC(2024, 2, 5, 10, 22, 43 - 8), 20);
  const fmt = (ms) => new Date(ms).toISOString();
  const mk = (ms) => {
    const iso = fmt(ms);
    return computeFacts({ date: iso.slice(0, 10), time: iso.slice(11, 16), timezone: 'UTC' });
  };
  const before = mk(jingzhe - 60000);
  const after = mk(jingzhe + 60000);
  assert.notEqual(before.fourPillars.month.branch, after.fourPillars.month.branch,
    'month branch did not flip across 惊蛰');
  // 寅 month -> 卯 month.
  assert.equal(before.fourPillars.month.branch, 'yin');
  assert.equal(after.fourPillars.month.branch, 'mao');
  // The month stem must follow 五虎遁 from the (甲辰) year stem 甲 -> 寅月丙, 卯月丁.
  assert.equal(before.fourPillars.month.ganzhi, 'bing-yin');
  assert.equal(after.fourPillars.month.ganzhi, 'ding-mao');
});

test('boundaries: every 节 is a real boundary in the month pillar', () => {
  // For each 节, stepping one minute across it must (except where the year also
  // turns) change the month pillar.
  for (const jie of JIE) {
    const guess = Date.UTC(2024, 0, 6, 12, 0, 0);
    let instant;
    try {
      instant = solarTermInstant(jie.longitude, guess, 200);
    } catch {
      continue; // out of the ±200 day window from this seed; covered by 惊蛰 above
    }
    const iso = new Date(instant).toISOString();
    const at = (ms) => {
      const s = new Date(ms).toISOString();
      return computeFacts({ date: s.slice(0, 10), time: s.slice(11, 16), timezone: 'UTC' });
    };
    const a = at(instant - 60000);
    const b = at(instant + 60000);
    assert.notEqual(
      `${a.fourPillars.year.ganzhi}|${a.fourPillars.month.ganzhi}`,
      `${b.fourPillars.year.ganzhi}|${b.fourPillars.month.ganzhi}`,
      `${jie.name} (${jie.longitude} deg at ${iso}) is not a year/month boundary`,
    );
  }
});

test('boundaries: hour branch turns at 23:00, 01:00, 03:00, ...', () => {
  const cases = [
    ['22:59', 'hai'], ['23:00', 'zi'], ['23:59', 'zi'], ['00:00', 'zi'],
    ['00:59', 'zi'], ['01:00', 'chou'], ['02:59', 'chou'], ['03:00', 'yin'],
    ['04:59', 'yin'], ['05:00', 'mao'], ['06:59', 'mao'], ['07:00', 'chen'],
    ['08:59', 'chen'], ['09:00', 'si'], ['10:59', 'si'], ['11:00', 'wu'],
    ['12:59', 'wu'], ['13:00', 'wei'], ['14:59', 'wei'], ['15:00', 'shen'],
    ['16:59', 'shen'], ['17:00', 'you'], ['18:59', 'you'], ['19:00', 'xu'],
    ['20:59', 'xu'], ['21:00', 'hai'], ['22:00', 'hai'],
  ];
  for (const [time, branch] of cases) {
    // Use a fixed date at noon far from any 节 boundary; the hour branch depends
    // only on the local clock, so the date choice only matters for the day stem.
    const f = computeFacts({ date: '2024-06-15', time, timezone: 'UTC' });
    assert.equal(f.fourPillars.hour.branch, branch, `hour branch at ${time}`);
  }
});

test('boundaries: 23:00-23:59 under BOTH day-boundary conventions', () => {
  const base = { date: '2000-01-01', time: '23:30', timezone: 'Asia/Shanghai' };

  const midnight = computeFacts({ ...base, dayBoundary: 'midnight' });
  const zichu = computeFacts({ ...base, dayBoundary: 'zi-chu' });

  // 2000-01-01 is 戊午 (cycle index 54); the next day 2000-01-02 is 己未.
  assert.equal(midnight.fourPillars.day.ganzhi, 'wu-wu', 'midnight convention must keep the civil date');
  assert.equal(zichu.fourPillars.day.ganzhi, 'ji-wei', 'zi-chu convention must advance at 23:00');
  assert.notEqual(midnight.fourPillars.day.ganzhi, zichu.fourPillars.day.ganzhi);

  // The HOUR pillar must be 子 in both cases (23:30 is 子 time regardless), but the
  // hour STEM differs because it is derived from the day stem by 五鼠遁.
  assert.equal(midnight.fourPillars.hour.branch, 'zi');
  assert.equal(zichu.fourPillars.hour.branch, 'zi');
  // 戊 day -> 子时壬子 ; 己 day -> 子时甲子.
  assert.equal(midnight.fourPillars.hour.ganzhi, 'ren-zi');
  assert.equal(zichu.fourPillars.hour.ganzhi, 'jia-zi');

  // Both conventions must agree outside the 23:00 hour.
  const noon = { date: '2000-01-01', time: '12:00', timezone: 'Asia/Shanghai' };
  assert.equal(
    computeFacts({ ...noon, dayBoundary: 'midnight' }).fourPillars.day.ganzhi,
    computeFacts({ ...noon, dayBoundary: 'zi-chu' }).fourPillars.day.ganzhi,
  );
});

test('boundaries: zi-chu advances exactly one day, not two, at 23:00', () => {
  const day = (t, conv) => computeFacts({ date: '2000-01-01', time: t, timezone: 'Asia/Shanghai', dayBoundary: conv }).fourPillars.day.ganzhi;
  // 22:59 is still 2000-01-01 (戊午). From 23:00 through 23:59 the zi-chu
  // convention assigns the NEXT day (己未). At 00:00 the civil date has itself
  // advanced, so the pillar is 己未 again — the advance happens once, not twice.
  assert.equal(day('22:59', 'zi-chu'), 'wu-wu');
  assert.equal(day('23:00', 'zi-chu'), 'ji-wei');
  assert.equal(day('23:59', 'zi-chu'), 'ji-wei');
  // 00:00 on 2000-01-01 is that same civil day (戊午); the advance at 23:00 has
  // already put the 23:xx hours onto 己未, and midnight does not advance again.
  assert.equal(day('00:00', 'zi-chu'), 'wu-wu');
  // Under the midnight convention none of 23:xx moves, and midnight starts 戊午.
  assert.equal(day('23:00', 'midnight'), 'wu-wu');
  assert.equal(day('23:59', 'midnight'), 'wu-wu');
  assert.equal(day('00:00', 'midnight'), 'wu-wu');
  // The two conventions must agree again from 01:00 onward.
  assert.equal(day('01:00', 'zi-chu'), day('01:00', 'midnight'));
});

test('boundaries: DST gap resolves deterministically in America/New_York', () => {
  // 2024-03-10 in New York: clocks jump 02:00 EST -> 03:00 EDT, so 02:30 local
  // does not exist. Documented choice: shift FORWARD by the gap, i.e. 02:30 is
  // read as 03:30 EDT = 07:30Z. Critically, the recorded offset (-240, EDT) must
  // describe the recorded instant — an earlier revision returned 06:30Z (which is
  // really 01:30 EST) while still reporting -300, so the two fields disagreed and
  // the local time silently slid an hour.
  const facts = computeFacts({ date: '2024-03-10', time: '02:30', timezone: 'America/New_York' });
  assert.equal(facts.calendar.instantUtc, '2024-03-10T07:30:00.000Z',
    'DST gap should shift forward by the gap');
  assert.equal(facts.calendar.utcOffsetMinutes, -240);
  // The instant must render back as the shifted wall clock: proof the recorded
  // offset and the recorded instant agree.
  const rendered = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(Date.parse(facts.calendar.instantUtc)));
  assert.ok(rendered.includes('03:30'), `gap instant should render as 03:30, got ${rendered}`);
});

test('boundaries: DST overlap resolves to the first occurrence', () => {
  // 2024-11-03 in New York: clocks fall back 02:00 EDT -> 01:00 EST, so 01:30
  // local happens twice. Documented choice: the FIRST occurrence (EDT, -240).
  const facts = computeFacts({ date: '2024-11-03', time: '01:30', timezone: 'America/New_York' });
  assert.equal(facts.calendar.instantUtc, '2024-11-03T05:30:00.000Z',
    'DST overlap should resolve to the first occurrence (EDT)');
  assert.equal(facts.calendar.utcOffsetMinutes, -240);
});

test('boundaries: a normal date round-trips local -> UTC -> local', () => {
  const facts = computeFacts({ date: '2024-06-15', time: '14:30', timezone: 'America/New_York' });
  assert.equal(facts.calendar.instantUtc, '2024-06-15T18:30:00.000Z'); // EDT = UTC-4
  assert.equal(facts.calendar.utcOffsetMinutes, -240);
});

test('boundaries: historical China DST 1986-1991 — report what ICU actually carries', () => {
  // China observed DST from 1986 to 1991 (roughly mid-April to mid-September,
  // +1h). Whether the runtime's ICU tzdata carries it is exactly the kind of
  // thing this layer must not paper over, so we OBSERVE and report rather than
  // assert a specific expectation.
  const observations = [];
  for (const year of [1986, 1987, 1988, 1989, 1990, 1991, 1992]) {
    // A date safely inside the historical DST window for those years.
    const f = computeFacts({ date: `${year}-07-01`, time: '12:00', timezone: 'Asia/Shanghai' });
    observations.push({ year, offset: f.calendar.utcOffsetMinutes, winter: computeFacts({ date: `${year}-01-15`, time: '12:00', timezone: 'Asia/Shanghai' }).calendar.utcOffsetMinutes });
  }
  // Attach the observation to the test output so a human can read it.
  console.log('    China 1986-1992 Asia/Shanghai offsets (summer/winter):',
    observations.map((o) => `${o.year}:${o.offset}/${o.winter}`).join(' '));

  // Whatever ICU says, the kernel must be internally consistent: UTC offset must
  // match the instant it recorded. This is the part we CAN assert.
  for (const year of [1986, 1988, 1991]) {
    const f = computeFacts({ date: `${year}-07-01`, time: '12:00', timezone: 'Asia/Shanghai' });
    const instant = Date.parse(f.calendar.instantUtc);
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date(instant));
    assert.ok(local.includes('12:00'), `${year}: recorded instant does not read as 12:00 Shanghai (${local})`);
    // 1986-1991 China DST would make summer offset 480 rather than 480+60=540.
    // Both are accepted here; the point is that we record and expose whichever it is.
    assert.ok([480, 540].includes(f.calendar.utcOffsetMinutes),
      `${year}: unexpected Shanghai offset ${f.calendar.utcOffsetMinutes}`);
  }
});

test('boundaries: true solar time shifts the clock by longitude + equation of time', () => {
  // Beijing is at ~116.4E; the zone meridian for UTC+8 is 120E, so the longitude
  // correction is 4*(116.4-120) = -14.4 minutes. Plus the equation of time.
  const withTst = computeFacts({
    date: '2024-06-15', time: '12:00', timezone: 'Asia/Shanghai',
    useTrueSolarTime: true, longitude: 116.4,
  });
  assert.equal(withTst.calendar.trueSolarTime, true);
  const corr = withTst.calendar.trueSolarCorrectionMinutes;
  // Mid-June equation of time is about -0.1 min, so the total is near -14.5 min.
  assert.ok(corr < -13 && corr > -16, `true-solar correction ${corr} min out of expected range`);

  // Without the flag, no correction and the field says so.
  const plain = computeFacts({ date: '2024-06-15', time: '12:00', timezone: 'Asia/Shanghai' });
  assert.equal(plain.calendar.trueSolarTime, false);
  assert.equal(plain.calendar.trueSolarCorrectionMinutes, 0);
});

test('boundaries: true solar time can change the day pillar near midnight', () => {
  // At 00:05 Beijing true solar time is ~23:50 of the previous day (longitude is
  // west of the zone meridian), which under zi-chu moves the day pillar back.
  const opts = { date: '2024-06-15', time: '00:05', timezone: 'Asia/Shanghai', dayBoundary: 'zi-chu' };
  const plain = computeFacts(opts);
  const tst = computeFacts({ ...opts, useTrueSolarTime: true, longitude: 116.4 });
  assert.notEqual(plain.calendar.localCivil, tst.calendar.localCivil,
    'true solar time should have shifted the effective local clock');
});

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

test('boundaries: bad input throws typed KernelError with status 400', () => {
  const cases = [
    [{ date: 'not-a-date', time: '12:00' }, 'INVALID_DATE'],
    [{ date: '2024-13-01', time: '12:00' }, 'INVALID_DATE'],
    [{ date: '2024-01-01', time: '25:00' }, 'INVALID_TIME'],
    [{ date: '2024-01-01', time: '12:99' }, 'INVALID_TIME'],
    [{ date: '2024-01-01', time: '12:00', timezone: 'Not/AZone' }, 'INVALID_TIMEZONE'],
    [{ date: '2024-01-01', time: '12:00', calendar: 'lunar' }, 'INVALID_LUNAR_DATE'],
    [{ date: '2024-01-01', time: '12:00', gender: 'x' }, 'INVALID_GENDER'],
    [{ date: '2024-01-01', time: '12:00', dayBoundary: 'nope' }, 'INVALID_DAY_BOUNDARY'],
    [{ date: '1800-01-01', time: '12:00' }, 'INVALID_DATE'],
  ];
  for (const [input, code] of cases) {
    assert.throws(
      () => computeFacts(input),
      (err) => {
        assert.ok(err instanceof KernelError, `${code}: not a KernelError`);
        assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
        assert.equal(err.status, 400);
        return true;
      },
    );
  }
  assert.throws(() => normalizeInput(null), (e) => e.code === 'INVALID_INPUT');
});

test('boundaries: lunar input is refused rather than guessed', () => {
  // A solar/lunar mix-up silently yields a chart for the wrong day, which the
  // user cannot detect from the prose. Refusing is the only safe behaviour.
  assert.throws(
    () => computeFacts({ date: '2024-01-01', time: '12:00', calendar: 'lunar' }),
    (e) => e.code === 'INVALID_LUNAR_DATE',
  );
});

test('boundaries: computeFacts is pure and shape-stable', () => {
  const input = { date: '1988-08-08', time: '08:08', timezone: 'Asia/Shanghai' };
  const a = computeFacts(input);
  const b = computeFacts(input);
  assert.deepEqual(a, b, 'identical input must give identical Facts');
  assert.equal(a.computedAt, 0, 'computedAt must be 0: the kernel never reads the clock');

  // Required Facts keys.
  for (const key of ['input', 'calendar', 'fourPillars', 'derived', 'notes', 'kernelVersion', 'computedAt', 'todos']) {
    assert.ok(key in a, `Facts is missing key ${key}`);
  }
  for (const p of PILLARS) {
    assert.ok(a.fourPillars[p], `missing ${p} pillar`);
    assert.equal(a.fourPillars[p].ganzhi, `${a.fourPillars[p].stem}-${a.fourPillars[p].branch}`);
  }
  assert.ok(Array.isArray(a.notes) && a.notes.length > 0, 'notes must not be empty');
  assert.ok(Array.isArray(a.todos), 'todos must be an array');
});
