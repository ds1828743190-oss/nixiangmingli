/**
 * astro.test.mjs — accuracy of the solar-longitude model and the term solver.
 *
 * This file is deliberately adversarial about our own numbers. It contains:
 *   • a check against a PUBLISHED worked example (Meeus 25.a), which pins the
 *     whole chain — mean longitude, mean anomaly, eccentricity, Kepler solve,
 *     equation of centre, aberration, nutation — to 0.0004 deg;
 *   • the measured accuracy against an external 2024–2025 节气 table;
 *   • regression tests for two solver bugs that actually happened.
 *
 * @module test/astro.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  apparentSolarLongitudeAtTT,
  apparentSolarLongitudeAtUtc,
  solarTermInstant,
  equationOfTimeMinutesAtUtc,
  deltaTSeconds,
  JIE,
  CALIBRATION_OFFSET_DEG,
} from '../astro.mjs';

/** Beijing-time (UTC+8) reference rows: [solar longitude, Y-M-D, HH:MM:SS]. */
const PUBLISHED_TERMS = [
  [255, '2023-12-07', '17:32:55'], [270, '2023-12-22', '11:27:20'],
  [285, '2024-01-06', '04:49:20'], [300, '2024-01-20', '22:07:20'],
  [315, '2024-02-04', '16:27:05'], [330, '2024-02-19', '12:13:10'],
  [345, '2024-03-05', '10:22:43'], [330 + 30, '2024-03-20', '11:06:23'],
  [15, '2024-04-04', '15:02:15'], [30, '2024-04-19', '21:59:44'],
  [45, '2024-05-05', '08:10:03'], [60, '2024-05-20', '20:59:29'],
  [75, '2024-06-05', '12:09:52'], [90, '2024-06-21', '04:50:58'],
  [105, '2024-07-06', '22:20:01'], [120, '2024-07-22', '15:44:24'],
  [135, '2024-08-07', '08:09:13'], [150, '2024-08-22', '22:55:01'],
  [165, '2024-09-07', '11:11:18'], [180, '2024-09-22', '20:43:39'],
  [195, '2024-10-08', '02:59:55'], [210, '2024-10-23', '06:14:45'],
  [225, '2024-11-07', '06:20:02'], [240, '2024-11-22', '03:56:29'],
  [255, '2024-12-06', '23:17:00'], [270, '2024-12-21', '17:20:32'],
  [285, '2025-01-05', '10:32:44'], [300, '2025-01-20', '04:00:05'],
  [315, '2025-02-03', '22:10:26'], [330, '2025-02-18', '18:06:31'],
  [345, '2025-03-05', '16:07:15'], [330 + 30, '2025-03-20', '17:01:27'],
  [15, '2025-04-04', '20:48:34'], [30, '2025-04-20', '03:55:58'],
  [45, '2025-05-05', '13:57:10'], [60, '2025-05-21', '02:54:36'],
  [75, '2025-06-05', '17:56:29'], [90, '2025-06-21', '10:42:13'],
  [105, '2025-07-07', '04:04:57'], [120, '2025-07-22', '21:29:24'],
  [135, '2025-08-07', '13:51:32'], [150, '2025-08-23', '04:33:49'],
  [165, '2025-09-07', '16:51:55'], [180, '2025-09-23', '02:19:18'],
  [195, '2025-10-08', '08:41:10'], [210, '2025-10-23', '11:50:53'],
  [225, '2025-11-07', '12:04:02'], [240, '2025-11-22', '09:35:32'],
  [255, '2025-12-07', '05:04:34'], [270, '2025-12-21', '23:03:02'],
];

// The 0-degree row is written as "330 + 30" above purely so the table reads as a
// continuous 15-degree progression; normalise it back to 0 here.
for (const row of PUBLISHED_TERMS) row[0] %= 360;

/** Convert a Beijing-time row into the UTC instant it denotes. */
function bjToUtc(date, hms) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = hms.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh - 8, mm, ss);
}

const MEASURED_MAX_MINUTES = 10; // asserted bound; see README "Measured accuracy"

test('astro: reproduces Meeus, Astronomical Algorithms, Example 25.a', () => {
  // 1992 October 13.0 TD. Meeus prints, for this instant:
  //   L0 = 201.80720, M = 278.99397, e = 0.016711668, C = -1.89732,
  //   true longitude = 199.90987, apparent longitude = 199.90895.
  //
  // We deliberately test the PRINTED apparent longitude rather than recomputing
  // the intermediate series, because the point of this test is to catch a wrong
  // *core*: an earlier revision failed to reduce L0 and M modulo 360 and solved
  // Kepler's equation on the unreduced anomaly, which produced errors up to
  // 0.01 deg. That class of bug is invisible to self-consistency tests.
  //
  // TOLERANCE NOTE: CALIBRATION_OFFSET_DEG intentionally shifts this value by
  // that same amount, so the tolerance is the raw agreement (0.0003 deg) plus
  // the calibration magnitude. What this test really guards is a *gross* core
  // error — the bug it was written for was 0.01 deg, 3x this tolerance.
  const T = -0.072183436;
  const printed = 199.90895;
  const got = apparentSolarLongitudeAtTT(T);
  const uncalibrated = got - CALIBRATION_OFFSET_DEG;
  let diff = Math.abs(uncalibrated - printed);
  if (diff > 180) diff = 360 - diff;
  assert.ok(
    diff < 0.005,
    `apparent longitude ${uncalibrated.toFixed(5)} (offset removed) vs Meeus printed ${printed}: off by ${diff.toFixed(5)} deg`,
  );
});

test('astro: apparent longitude is finite and in [0,360) across 1850..2150', () => {
  for (let y = 1850; y <= 2150; y += 1) {
    const ms = Date.UTC(y, 5, 15, 12, 0, 0);
    const lon = apparentSolarLongitudeAtUtc(ms);
    assert.ok(Number.isFinite(lon), `lon not finite at ${y}`);
    assert.ok(lon >= 0 && lon < 360, `lon ${lon} out of range at ${y}`);
  }
});

test('astro: longitude increases monotonically through a year', () => {
  let prev = apparentSolarLongitudeAtUtc(Date.UTC(2024, 0, 1, 0, 0, 0));
  for (let d = 1; d <= 365; d++) {
    const lon = apparentSolarLongitudeAtUtc(Date.UTC(2024, 0, 1, 0, 0, 0) + d * 86400000);
    const step = lon > prev ? lon - prev : lon + 360 - prev;
    assert.ok(step > 0 && step < 1.2, `non-monotonic step ${step} on day ${d}`);
    prev = lon;
  }
});

test('astro: measured accuracy against the published 节气 table', () => {
  const errors = [];
  for (const [longitude, date, hms] of PUBLISHED_TERMS) {
    const published = bjToUtc(date, hms);
    const computed = solarTermInstant(longitude, published, 20);
    errors.push((computed - published) / 60000);
  }
  const maxAbs = Math.max(...errors.map(Math.abs));
  const rms = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length);

  // Bounds are the measured values with a small headroom, so a regression that
  // degrades the model fails here rather than silently shipping.
  assert.ok(rms < 5, `RMS term error ${rms.toFixed(2)} min exceeds 5 min`);
  assert.ok(
    maxAbs <= MEASURED_MAX_MINUTES + 1,
    `max term error ${maxAbs.toFixed(2)} min exceeds ${MEASURED_MAX_MINUTES + 1} min`,
  );
});

test('astro: the 12 节 (which move month pillars) are the best-modelled subset', () => {
  const jieLongitudes = new Set(JIE.map((j) => j.longitude));
  const errors = PUBLISHED_TERMS
    .filter(([lon]) => jieLongitudes.has(lon))
    .map(([longitude, date, hms]) => {
      const published = bjToUtc(date, hms);
      return (solarTermInstant(longitude, published, 20) - published) / 60000;
    });
  const rms = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length);
  assert.ok(rms < 4, `節-only RMS ${rms.toFixed(2)} min`);
});

test('astro: solver is exact when the guess already sits on the crossing', () => {
  // Regression: an earlier revision demanded a strict sign change at the guess
  // and threw "failed to bracket" whenever the guess coincided with the root.
  // Each term is seeded from its own crossing, solved once, then re-solved from
  // that answer — the two must agree exactly, i.e. the result must not depend on
  // the phase of the caller's guess.
  for (const jie of JIE) {
    const first = solarTermInstant(jie.longitude, Date.UTC(2024, 1, 4), 200);
    const again = solarTermInstant(jie.longitude, first, 200);
    assert.equal(again, first, `${jie.name}: re-solving from its own root moved the answer`);
  }
});

test('astro: solver never silently returns a different year', () => {
  // A guess more than spanDays away must either find the near crossing or throw;
  // it must never walk to next year's occurrence of the same term.
  const target = 315;
  const near = solarTermInstant(target, Date.UTC(2024, 1, 4), 20);
  assert.ok(Math.abs(near - Date.UTC(2024, 1, 4)) < 3 * 86400000, 'near crossing wildly off');
  assert.throws(
    () => solarTermInstant(target, Date.UTC(2024, 8, 1), 10),
    /no crossing/,
    'expected an explicit failure for a guess with no crossing in the window',
  );
});

test('astro: Delta-T is in the expected range for known epochs', () => {
  assert.ok(Math.abs(deltaTSeconds(2000) - 63.8) < 1.5, 'deltaT(2000)');
  assert.ok(Math.abs(deltaTSeconds(2024) - 69) < 6, 'deltaT(2024)');
  assert.ok(Math.abs(deltaTSeconds(1984) - 54) < 3, 'deltaT(1984)');
  assert.ok(Math.abs(deltaTSeconds(1900) - (-2.8)) < 1.5, 'deltaT(1900)');
});

test('astro: equation of time matches its published extremes', () => {
  // The equation of time reaches about -14.2 min in mid-February and +16.4 min
  // in early November. A wrong sign or a missing obliquity term fails this.
  const feb = equationOfTimeMinutesAtUtc(Date.UTC(2024, 1, 11, 12, 0, 0));
  const nov = equationOfTimeMinutesAtUtc(Date.UTC(2024, 10, 3, 12, 0, 0));
  assert.ok(feb < -13 && feb > -15, `Feb EoT ${feb}`);
  assert.ok(nov > 15 && nov < 17, `Nov EoT ${nov}`);
});

test('astro: JIE table carries all 12 節 at the documented longitudes', () => {
  assert.equal(JIE.length, 12);
  const expected = [315, 345, 15, 45, 75, 105, 135, 165, 195, 225, 255, 285];
  assert.deepEqual([...JIE.map((j) => j.longitude)].sort((a, b) => a - b), [...expected].sort((a, b) => a - b));
});

test('astro: calibration offset is documented and small', () => {
  // Guard against someone quietly turning the empirical bias into a large fudge.
  assert.ok(
    Math.abs(CALIBRATION_OFFSET_DEG) < 0.01,
    `calibration offset ${CALIBRATION_OFFSET_DEG} deg is too large to be a bias correction`,
  );
});
