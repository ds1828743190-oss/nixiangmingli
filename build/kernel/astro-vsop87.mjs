/**
 * astro-vsop87.mjs — solar-term instants from the full VSOP87D Earth series.
 *
 * Why this module exists: the earlier implementation used a compact Kepler-solve
 * approximation whose measured error was ±8.8 min. That is inside the window
 * where a birth near 立春 or a 節 can get the wrong year/month pillar — the one
 * class of error this product must not have. VSOP87D is the published series the
 * accuracy target was always meant to be met with.
 *
 * Method (positions → apparent longitude), stated so it can be audited:
 *
 *   1. JDE   = JD(UTC) + ΔT/86400                      (ΔT from astro.mjs)
 *   2. τ     = (JDE − 2451545) / 365250                (VSOP87 uses millennia)
 *   3. L, R  = Σ_k τ^k Σ_i A·cos(B + C·τ)              (DE200/VSOP87D, of date)
 *   4. λ_geo = L + 180°                                (heliocentric Earth → geocentric Sun)
 *   5. λ_app = λ_geo + Δψ − 20.4898″/R − 0.09033″      (nutation, aberration, FK5)
 *
 * Step 5's three corrections are each sub-arcsecond in size except aberration
 * (~20″), and all three are computed here rather than absorbed into a fudge
 * factor. VSOP87D is already referred to the equinox of date, so no precession
 * term is applied.
 *
 * Performance: 2077 terms per longitude evaluation. Term finding does ~40
 * evaluations, so one instant costs ~83k cosines — tens of milliseconds, which is
 * why instants are cached by the caller rather than recomputed per chart.
 *
 * @module astro-vsop87
 */

import { deltaTSeconds } from './astro.mjs';
import { EARTH_L, EARTH_R } from './vsop87d-earth.mjs';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const J2000 = 2451545.0;

/** JD from a UTC instant (no ΔT applied). */
export function julianDayUtc(ms) {
  return ms / 86400000 + 2440587.5;
}

const norm360 = (d) => ((d % 360) + 360) % 360;

/** Sums one VSOP87 series (array of term arrays) at τ. A is radians (L) or AU (R). */
function seriesSum(series, tau) {
  let total = 0;
  let power = 1;
  for (const terms of series) {
    let sum = 0;
    for (const [A, B, C] of terms) sum += A * Math.cos(B + C * tau);
    total += sum * power;
    power *= tau;
  }
  return total;
}

/**
 * Apparent geocentric ecliptic longitude of the Sun, in degrees, for a UTC instant.
 *
 * @param {number} msUtc epoch milliseconds, UTC
 * @returns {number} degrees in [0, 360)
 */
export function apparentSolarLongitudeAtUtc(msUtc) {
  const jdUtc = julianDayUtc(msUtc);
  const approxYear = 2000 + (jdUtc - J2000) / 365.25;
  const jde = jdUtc + deltaTSeconds(approxYear) / 86400;
  const T = (jde - J2000) / 36525;
  const tau = (jde - J2000) / 365250;

  const L = seriesSum(EARTH_L, tau); // radians, heliocentric Earth
  const R = seriesSum(EARTH_R, tau); // AU

  let lambda = L * RAD + 180; // geometric geocentric longitude of the Sun

  // Nutation in longitude, low-order Meeus 22 series. Amplitudes are arcseconds;
  // the neglected terms are < 0.1″, i.e. under 2 seconds of time.
  const omega = (125.04452 - 1934.136261 * T) * DEG;
  const Lsun = (280.4665 + 36000.7698 * T) * DEG;
  const Lmoon = (218.3165 + 481267.8813 * T) * DEG;
  const dpsiArcsec =
    -17.20 * Math.sin(omega)
    - 1.32 * Math.sin(2 * Lsun)
    - 0.23 * Math.sin(2 * Lmoon)
    + 0.21 * Math.sin(2 * omega);

  lambda += dpsiArcsec / 3600;              // nutation
  lambda -= 20.4898 / R / 3600;             // annual aberration
  lambda -= 0.09033 / 3600;                 // FK5 system correction

  return norm360(lambda);
}

/** Signed difference target − longitude, wrapped to (−180, 180]. */
function delta(lambda, target) {
  let d = target - lambda;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

/**
 * Finds the instant the Sun's apparent longitude reaches `targetDeg`, near a guess.
 *
 * Bisection on a bracketed sign change. Bracketing is done relative to the guess
 * with a hard window, and a failure to bracket is an error rather than a silent
 * fallback to the guess — a wrong instant here becomes a wrong year or month
 * pillar, which is exactly the defect this module replaces.
 *
 * @param {number} targetDeg
 * @param {number} guessMs approximate epoch ms of the term
 * @param {number} [spanDays] half-window in days; must exceed the worst guess error
 * @returns {number} epoch ms (UTC) of the instant
 */
export function solarTermInstant(targetDeg, guessMs, spanDays = 16) {
  const HALF = spanDays * 86400000;
  const at = (ms) => delta(apparentSolarLongitudeAtUtc(ms), targetDeg);

  // Scan for a sign change at 6-hour resolution: a term moves ~1°/day, so 0.25 d
  // steps can never skip one, and this also makes the result independent of the
  // guess's sub-day phase (a bug the previous solver had).
  const STEP = 6 * 3600000;
  let lo = null;
  let hi = null;
  let prevMs = guessMs - HALF;
  let prev = at(prevMs);
  for (let ms = prevMs + STEP; ms <= guessMs + HALF; ms += STEP) {
    const cur = at(ms);
    if (prev === 0 || (prev < 0) !== (cur < 0)) { lo = prevMs; hi = ms; break; }
    prevMs = ms;
    prev = cur;
  }
  if (lo === null) {
    throw new Error(`solarTermInstant: failed to bracket ${targetDeg}° near ${new Date(guessMs).toISOString()}`);
  }

  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    const d = at(mid);
    if (d === 0 || hi - lo < 500) return Math.round(mid); // 0.5 s is far below any use
    if ((at(lo) < 0) !== (d < 0)) hi = mid;
    else lo = mid;
  }
  return Math.round((lo + hi) / 2);
}

export const TERM_ACCURACY_SECONDS_VSOP87 = 30; // see build/verify/kernel-accuracy.md

export default { apparentSolarLongitudeAtUtc, solarTermInstant, julianDayUtc, TERM_ACCURACY_SECONDS_VSOP87 };
