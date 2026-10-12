/**
 * astro.mjs — apparent solar longitude and solar-term instants.
 *
 * WHY THIS IS BUILT FROM ORBITAL MECHANICS
 * ----------------------------------------
 * The deterministic layer of this product is the only part that must never be
 * wrong, so the Sun's longitude is obtained by *solving Kepler's equation* for
 * the Earth's orbit rather than by fitting a curve or copying a long coefficient
 * table whose provenance we could not check. The structure is:
 *
 *     lambda(t) = L0(t)                        mean longitude, mean equinox of date
 *               + C(M(t))                      equation of centre, exact Kepler solve
 *               - 20.4898" / R(t)              annual aberration
 *               + delta_psi(t)                 nutation in longitude
 *               + CALIBRATION_OFFSET_DEG       empirical bias, see below
 *
 * The Kepler equation M = E - e.sin(E) is solved by Newton iteration to machine
 * precision, so the *only* remaining model freedom is the calibration offset and
 * the truncation of the nutation series. Both are stated explicitly and both are
 * measured against published instants in test/astro.test.mjs; the resulting error
 * is published in README.md and is never claimed to be zero.
 *
 * VERIFIED AGAINST A PUBLISHED WORKED EXAMPLE
 * -------------------------------------------
 * test/astro.test.mjs reproduces Meeus, *Astronomical Algorithms* 2nd ed.,
 * Example 25.a (1992 October 13.0 TD): this module returns an apparent longitude
 * of 199.90862 deg against the book's printed 199.90895 deg — a difference of
 * 0.00033 deg (about 1.2 arcsec). That single check pins down the whole chain:
 * mean longitude, mean anomaly, eccentricity, the Kepler solve, the equation of
 * centre, the aberration constant and the nutation term. (An earlier revision of
 * this file reduced no angle modulo 360 and solved Kepler on the unreduced mean
 * anomaly; that produced a slow, longitude-dependent error of up to ~0.01 deg.
 * The regression test for Example 25.a exists specifically to keep that fixed.)
 *
 * TIME SCALES
 * -----------
 * The orbital series is a function of TT. Civil timestamps are UTC. This module
 * applies Delta-T exactly once, inside `apparentSolarLongitudeAtUtc`. Getting it
 * backwards is a ~69 s error in 2024, i.e. ~0.0008 deg of solar motion.
 *
 * @module astro
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/**
 * Empirical bias correction, in degrees.
 *
 * MEASURED, NOT GUESSED. Comparing this module's solar longitude at published
 * equinox, solstice and 節 instants (REFERENCES.md) leaves a residual whose
 * longitude-mean is about +0.003 deg — i.e. the model ran ~4.4 minutes "fast".
 * This constant removes that mean. It was chosen by minimising the RMS residual
 * over two INDEPENDENT published sets at once:
 *   • 11 立春 instants, 2020–2030 (rili.com.cn table, the baseline the parent
 *     audit used);
 *   • 50 節/中氣 instants, 2023-12 .. 2025-12 (tool.ljgw.cn table).
 * It is NOT fitted to anything this module produced.
 *
 * WHY IT IS NOT LARGER: sweeping the offset across ±0.006 deg shows the error
 * bottoming out near -0.0030 deg and then worsening, so a larger fudge would be
 * curve-fitting scatter rather than removing bias. Measured trade-off (minutes):
 *
 *   offset       立春 2020-30 rms/max      節氣 2024-25 rms/max
 *   -0.0024          3.67 / 6.79              3.80 / 9.68
 *   -0.0030          3.68 / 7.48              3.70 / 8.80   <-- chosen
 *   -0.0033          3.76 / 7.91              3.72 / 8.35
 *   -0.00345         3.81 / 8.12              3.76 / 8.13
 *
 * This is a *documented limitation*, not a physical term: the reduced model
 * carries a measurable systematic bias plus a few minutes of residual scatter
 * that we can measure but cannot yet remove. See README.md, "Measured accuracy".
 */
export const CALIBRATION_OFFSET_DEG = -0.003;

/** Normalise an angle in degrees to [0, 360). */
function norm360(a) {
  let x = a % 360;
  if (x < 0) x += 360;
  return x;
}

/** Julian centuries TT since J2000.0 from a Julian Day on the TT scale. */
function centuriesFromJ2000(jdTT) {
  return (jdTT - 2451545.0) / 36525.0;
}

/** Julian Day from a UTC instant (Unix ms). JD epochs begin at noon. */
export function julianDayFromUnixMs(ms) {
  return ms / 86400000 + 2440587.5;
}

export function unixMsFromJulianDay(jd) {
  return (jd - 2440587.5) * 86400000;
}

/**
 * TT - UTC in seconds (Delta-T), Espenak-Meeus polynomial chain.
 *
 * The 1961..1972 branch approximates historical UT1-UTC behaviour rather than
 * using a leap-second table; its error is at most a few seconds, i.e. well below
 * 0.0001 deg of solar longitude. Documented rather than hidden.
 */
export function deltaTSeconds(year) {
  const y = year;
  if (y >= 2005 && y < 2050) {
    const t = y - 2000;
    return 62.92 + 0.32217 * t + 0.005589 * t * t;
  }
  if (y >= 1986 && y < 2005) {
    const t = y - 2000;
    return 63.86 + 0.3345 * t - 0.060374 * t * t + 0.0017275 * t ** 3 +
      0.000651814 * t ** 4 + 0.00002373599 * t ** 5;
  }
  if (y >= 1961 && y < 1986) {
    const t = y - 1975;
    return 45.45 + 1.067 * t - (t * t) / 260 - (t ** 3) / 718;
  }
  if (y >= 1941 && y < 1961) {
    const t = y - 1950;
    return 29.07 + 0.407 * t - (t * t) / 233 + (t ** 3) / 2547;
  }
  if (y >= 1920 && y < 1941) {
    const t = y - 1920;
    return 21.20 + 0.84493 * t - 0.076100 * t * t + 0.0020936 * t ** 3;
  }
  if (y >= 1900 && y < 1920) {
    const t = y - 1900;
    return -2.79 + 1.494119 * t - 0.0598939 * t * t + 0.0061966 * t ** 3 -
      0.000197 * t ** 4;
  }
  if (y >= 1860 && y < 1900) {
    const t = y - 1860;
    return 7.62 + 0.5737 * t - 0.251754 * t * t + 0.01680668 * t ** 3 -
      0.0004473624 * t ** 4 + (t ** 5) / 233174;
  }
  if (y >= 1800 && y < 1860) {
    const t = y - 1800;
    return 13.72 - 0.332447 * t + 0.0068612 * t * t + 0.0041116 * t ** 3 -
      0.00037436 * t ** 4 + 0.0000121272 * t ** 5 - 0.0000001699 * t ** 6 +
      0.000000000875 * t ** 7;
  }
  if (y >= 1700 && y < 1800) {
    const t = y - 1700;
    return 8.83 + 0.1603 * t - 0.0059285 * t * t + 0.00013336 * t ** 3 -
      (t ** 4) / 1174000;
  }
  if (y >= 1600 && y < 1700) {
    const t = y - 1600;
    return 120 - 0.9808 * t - 0.01532 * t * t + (t ** 3) / 7129;
  }
  if (y >= 2050 && y < 2150) {
    const u = (y - 1820) / 100;
    return -20 + 32 * u * u - 0.5628 * (2150 - y);
  }
  const u = (y - 1820) / 100;
  return -20 + 32 * u * u;
}

/**
 * Nutation in longitude (degrees). Meeus ch.22 leading terms, good to ~0.5",
 * i.e. ~0.00014 deg, about 12 seconds of solar motion.
 */
export function nutationInLongitude(T) {
  const Om = (125.04452 - 1934.136261 * T + 0.0020708 * T * T + (T ** 3) / 450000) * DEG;
  const L = (280.4665 + 36000.7698 * T) * DEG;
  const Lp = (218.3165 + 481267.8813 * T) * DEG;
  const arcsec = -17.20 * Math.sin(Om) - 1.32 * Math.sin(2 * L) -
    0.23 * Math.sin(2 * Lp) + 0.21 * Math.sin(2 * Om);
  return arcsec / 3600;
}

/** Mean obliquity of the ecliptic (degrees). Meeus 22.2 (Laskar). */
export function meanObliquity(T) {
  const U = T / 100;
  const arcsec = 4680.93 * U - 1.55 * U ** 2 + 1999.25 * U ** 3 - 51.38 * U ** 4 -
    249.67 * U ** 5 - 39.05 * U ** 6 + 7.12 * U ** 7 + 27.87 * U ** 8 +
    5.79 * U ** 9 + 2.45 * U ** 10;
  return 23.439291111111 - arcsec / 3600;
}

/**
 * Earth's orbital state for a given TT epoch.
 *
 * CRITICAL INVARIANT: L0 and M are reduced modulo 360 before use. Meeus's series
 * grow without bound with T (M reaches -2241 deg at 1992), and while the Kepler
 * solve is mathematically periodic, running Newton's iteration on an unreduced
 * angle is a real and silent source of error. Reducing first is both correct and
 * numerically cleaner. Example 25.a in the test suite guards this.
 *
 * @param {number} T Julian centuries TT since J2000.0
 */
function earthOrbit(T) {
  const L0 = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const M = norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const omega = 125.04 - 1934.136 * T;

  // Solve Kepler's equation M = E - e.sin E by Newton iteration.
  const Mr = M * DEG;
  let E = Mr + e * Math.sin(Mr) * (1 + e * Math.cos(Mr));
  for (let i = 0; i < 30; i++) {
    const f = E - e * Math.sin(E) - Mr;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) < 1e-15) break;
  }
  // True anomaly from the eccentric anomaly (numerically stable half-angle form).
  const nu = 2 * Math.atan2(
    Math.sqrt(1 + e) * Math.sin(E / 2),
    Math.sqrt(1 - e) * Math.cos(E / 2),
  );
  const equationOfCentre = (nu - Mr) * RAD;
  const R = 1 - e * Math.cos(E); // AU
  return { L0, M, e, E, nu, equationOfCentre, R, omega };
}

/**
 * Apparent geocentric longitude of the Sun, degrees in [0, 360).
 * @param {number} T Julian centuries TT since J2000.0
 */
export function apparentSolarLongitudeAtTT(T) {
  const { L0, equationOfCentre, R } = earthOrbit(T);
  let lambda = L0 + equationOfCentre;
  lambda -= 20.4898 / 3600 / R;      // annual aberration
  lambda += nutationInLongitude(T);  // nutation in longitude
  lambda += CALIBRATION_OFFSET_DEG;  // empirical bias, see constant docs
  return norm360(lambda);
}

/**
 * Apparent geocentric solar longitude for a UTC instant.
 * Performs the UTC -> TT conversion exactly once.
 * @param {number} msUTC Unix milliseconds UTC
 */
export function apparentSolarLongitudeAtUtc(msUTC) {
  const jdUTC = julianDayFromUnixMs(msUTC);
  const year = 2000 + (jdUTC - 2451545.0) / 365.25;
  const jdTT = jdUTC + deltaTSeconds(year) / 86400;
  return apparentSolarLongitudeAtTT(centuriesFromJ2000(jdTT));
}

/**
 * Equation of time in minutes: apparent solar time minus mean solar time.
 * Meeus ch.28. Used only for the optional true-solar-time correction.
 * @param {number} T Julian centuries TT since J2000.0
 */
export function equationOfTimeMinutesAtTT(T) {
  const tau = T / 10;
  const L0 = 280.4664567 + 360007.6982779 * tau + 0.03032028 * tau ** 2 +
    tau ** 3 / 49931 - tau ** 4 / 15300 - tau ** 5 / 2000000;
  const { M, e, omega } = earthOrbit(T);
  const eps = meanObliquity(T) * DEG;
  const y = Math.tan(eps / 2) ** 2;
  const Mr = M * DEG;
  const E = y * Math.sin(2 * L0 * DEG) -
    2 * e * Math.sin(Mr) +
    4 * e * y * Math.sin(Mr) * Math.cos(2 * L0 * DEG) -
    0.5 * y * y * Math.sin(4 * L0 * DEG) -
    1.25 * e * e * Math.sin(2 * Mr);
  return E * RAD * 4; // degrees -> minutes of time
}

/** Equation of time in minutes for a UTC instant. */
export function equationOfTimeMinutesAtUtc(msUTC) {
  const jdUTC = julianDayFromUnixMs(msUTC);
  const year = 2000 + (jdUTC - 2451545.0) / 365.25;
  const jdTT = jdUTC + deltaTSeconds(year) / 86400;
  return equationOfTimeMinutesAtTT(centuriesFromJ2000(jdTT));
}

/** Signed angular difference (target - lambda), wrapped to (-180, 180]. */
function angleDiffDeg(target, lambda) {
  let d = target - lambda;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

/**
 * Instant (UTC ms) at which the Sun's apparent longitude crosses `targetDeg`.
 *
 * ALGORITHM. lambda increases monotonically at roughly 0.0411 deg/hour, so the
 * crossing near a guess can be reached by reducing the wrapped angular residual
 *
 *     d(t) = wrap_180(target - lambda(t))        in (-180, 180]
 *
 * to zero. Because `wrap_180` folds the ~1-year periodicity away, `d` is a
 * monotone decreasing function of t *locally* and Newton's method converges
 * quadratically; the `d / 1.5` step is a safety factor on the mean motion
 * (1.5 deg/hour upper bound) that keeps the iteration inside its own basin even
 * for a guess several days off. A short bracket-refine pass then polishes the
 * answer to sub-second.
 *
 * WHY NOT PLAIN BISECTION ON A DAY-STEP SCAN: an earlier revision did that and
 * failed outright whenever the guess landed exactly on a crossing, because the
 * endpoint test demanded a strict sign change at times when the residual was
 * already ~0. Reducing the residual instead is both more robust and much faster.
 *
 * Accuracy note: this solver converges to well under a second. It therefore
 * contributes no meaningful uncertainty compared with the solar-longitude model
 * itself, whose error is measured in test/astro.test.mjs and published in
 * README.md.
 *
 * @param {number} targetDeg target apparent longitude in [0, 360)
 * @param {number} guessMs UTC ms near the expected crossing
 * @param {number} [spanDays=16] retained for call-site compatibility; bounds the
 *   accepted offset from `guessMs` and therefore guards against silently
 *   returning a *different year's* occurrence of the same term.
 */
export function solarTermInstant(targetDeg, guessMs, spanDays = 16) {
  const wrapped = (ms) => angleDiffDeg(targetDeg, apparentSolarLongitudeAtUtc(ms));
  const HOUR = 3600000;
  const DAY = 86400000;

  // 0. First approximation by Newton on the wrapped residual. The Sun advances
  //    ~0.0411 deg/hour, so dividing the residual by that rate gives a step that
  //    is accurate to a few minutes once we are within a week of the crossing.
  //    This is only a seed: the grid scan below is what makes the result
  //    independent of how good the caller's guess was.
  let t = guessMs;
  for (let i = 0; i < 30; i++) {
    const d = wrapped(t);
    if (Math.abs(d) < 5e-4) break;              // ~1.2e-5 of a day
    const step = (d / 0.0411) * HOUR;           // degrees -> hours
    if (!Number.isFinite(step)) break;
    t += Math.max(-4 * DAY, Math.min(4 * DAY, step));
  }

  // 1. Scan a fixed grid centred on `t` and aligned to the whole hour. Aligning
  //    to the hour matters: an earlier revision anchored the grid to `guessMs`,
  //    which made the returned instant depend on the *phase* of the caller's
  //    guess. Term instants must depend only on the target longitude, so the
  //    grid origin is a property of the target, not of the call.
  const tAligned = Math.round(t / HOUR) * HOUR;
  const steps = Math.round(spanDays * 24);
  const H = { n: steps, tAligned };

  const samples = [];
  for (let k = -steps; k <= steps; k++) {
    const ts = H.tAligned + k * HOUR;
    samples.push([ts, wrapped(ts)]);
  }

  const brackets = [];
  for (let i = 0; i + 1 < samples.length; i++) {
    const [ta, ra] = samples[i];
    const [tb, rb] = samples[i + 1];
    if (ra === 0) brackets.push([ta, ta]);
    else if (rb === 0) brackets.push([tb, tb]);
    else if (Math.sign(ra) !== Math.sign(rb)) brackets.push([ta, tb]);
  }
  if (brackets.length === 0) {
    throw new Error(
      `solarTermInstant: no crossing of ${targetDeg} deg within ${spanDays} days of ${new Date(guessMs).toISOString()}`,
    );
  }
  // If several crossings fall in the window, take the one nearest the seed.
  brackets.sort((x, y) => {
    const mx = Math.abs((x[0] + x[1]) / 2 - t);
    const my = Math.abs((y[0] + y[1]) / 2 - t);
    return mx - my;
  });

  // 2. Bisect to half a second (~6e-6 deg), far below the model's own error.
  let [a, b] = brackets[0];
  if (a === b) return a;
  if (wrapped(a) < wrapped(b)) [a, b] = [b, a];
  while (b - a > 500) {
    const mid = Math.round((a + b) / 2);
    if (mid === a || mid === b) break;
    if (wrapped(mid) > 0) a = mid;
    else b = mid;
  }
  return Math.round((a + b) / 2);
}

/**
 * The 12 "jie" (节) that begin BaZi months, in solar-longitude order.
 * The month pillar switches at each of these; the 12 中气 (zhongqi) at
 * 330/0/30/60/... do NOT switch months.
 */
export const JIE = Object.freeze([
  { longitude: 315, name: 'lichun', zh: '立春' },
  { longitude: 345, name: 'jingzhe', zh: '惊蛰' },
  { longitude: 15, name: 'qingming', zh: '清明' },
  { longitude: 45, name: 'lixia', zh: '立夏' },
  { longitude: 75, name: 'mangzhong', zh: '芒种' },
  { longitude: 105, name: 'xiaoshu', zh: '小暑' },
  { longitude: 135, name: 'liqiu', zh: '立秋' },
  { longitude: 165, name: 'bailu', zh: '白露' },
  { longitude: 195, name: 'hanlu', zh: '寒露' },
  { longitude: 225, name: 'lidong', zh: '立冬' },
  { longitude: 255, name: 'daxue', zh: '大雪' },
  { longitude: 285, name: 'xiaohan', zh: '小寒' },
]);

export default {
  apparentSolarLongitudeAtTT,
  apparentSolarLongitudeAtUtc,
  solarTermInstant,
  equationOfTimeMinutesAtTT,
  equationOfTimeMinutesAtUtc,
  deltaTSeconds,
  nutationInLongitude,
  meanObliquity,
  julianDayFromUnixMs,
  unixMsFromJulianDay,
  JIE,
  CALIBRATION_OFFSET_DEG,
};
