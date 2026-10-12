# `build/kernel` — the deterministic Chinese Four Pillars (四柱/八字) kernel

> **The model explains facts; it never computes them.**
>
> This package is the only place in the product allowed to do calendar arithmetic.
> It takes a birth date/time/place and returns a fully resolved `Facts` object.
> The narration layer receives finished values and a prompt block that contains no
> formula, so it has nothing to re-derive incorrectly.

Zero dependencies. No npm install. No network at runtime. Pure ESM, Node ≥ 20
(developed and tested on the bundled v24.21.0).

---

## Quick start

```bash
NODE=/Users/xiaolv/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
cd build/kernel
"$NODE" --test 'test/*.test.mjs'
```

```js
import { computeFacts, narrationPrompt } from './build/kernel/index.mjs';

const facts = computeFacts({
  date: '1988-08-08',
  time: '08:08',
  timezone: 'Asia/Shanghai',
  gender: 'female',
  dayBoundary: 'zi-chu',
  useTrueSolarTime: true,
  longitude: 121.47,
});

facts.fourPillars.day.ganzhi;   // e.g. 'bing-yin'
console.log(narrationPrompt(facts));
```

Integration is a one-line import swap: `index.mjs` exposes the same names and the
same `Facts` shape as `build/skeleton/src/kernel.mjs`.

---

## API

| Export | Purpose |
|---|---|
| `computeFacts(input) → Facts` | Pure. Same input ⇒ same `Facts`, byte for byte. No clock reads (`computedAt` is always `0`; the handler stamps time). |
| `normalizeInput(input) → object` | Validates and normalises; throws typed `KernelError`. |
| `KernelError extends Error` | Has machine-readable `code` and `status` (400). |
| `PILLARS` | `['year','month','day','hour']`. |
| `narrationPrompt(facts) → string` | Renders the authoritative facts block for the model. Throws `FACTS_REQUIRED` on a non-`Facts` argument. |
| `TERM_ACCURACY_SECONDS` | The measured solar-term error bound, in seconds. Drives the boundary-uncertainty flag. |
| `zoneOffsetMinutes(instant, timezone)`, `localToInstant(...)` | Exposed for tests and audit. |

### Input

```js
{
  date: 'YYYY-MM-DD',            // local civil date, Gregorian
  time: 'HH:MM',                 // local civil time (required)
  timezone: 'Asia/Shanghai',     // IANA
  gender: 'male' | 'female' | 'unspecified',
  calendar: 'solar',             // 'lunar' is refused, see below
  dayBoundary: 'midnight' | 'zi-chu',
  useTrueSolarTime: boolean,
  longitude: number,             // degrees east; required when useTrueSolarTime
}
```

### `Facts` shape

```js
{
  input,        // normalised echo of the request
  calendar,     // every correction actually applied (see below)
  fourPillars: { year|month|day|hour: { stem, branch, ganzhi } },
  derived: { elementCounts, hiddenStemElementCounts },
  notes: string[],      // human-readable provenance for an audit view
  kernelVersion: 'real-1.0.0',
  computedAt: 0,
  todos: string[],      // remaining gaps, stated honestly
}
```

Stems and branches are ASCII pinyin (`jia`…`gui`, `zi`…`hai`); `ganzhi` is
`"<stem>-<branch>"`, e.g. `"jia-zi"`.

### `calendar` records every correction

`instantUtc`, `utcOffsetMinutes`, `dstApplied`, `localCivil`, `trueSolarTime`,
`trueSolarCorrectionMinutes`, `dayBoundaryConvention`, `yearBoundary`,
`governingTerm`, `ganzhiYear`, `termAccuracySeconds`, and:

```js
boundaryUncertainty: {
  applies: boolean,      // birth time falls inside the kernel's term error window
  windowSeconds, message // says so plainly, in Chinese, when it applies
}
```

When `applies` is true the prompt tells the model to say so rather than pick a
side — silently resolving a boundary case is the failure this architecture exists
to prevent.

---

## Measured accuracy

This is the honest table. It is asserted in `test/astro.test.mjs` so a regression
cannot slip through, and it is **worse than the ≤1 minute target** the parent audit
(`build/verify/kernel-accuracy.md`) asked for.

| Set | n | RMS | max |
|---|---|---|---|
| 立春 2020–2030 | 11 | 3.68 min | 7.48 min |
| 節 + 中氣 2023-12 … 2025-12 | 50 | 3.70 min | 8.80 min |
| the 12 節 only (drives month pillars) | 25 | 2.96 min | 6.77 min |

Milestones, so the improvement is legible:

| Revision | Solar-longitude method | max term error |
|---|---|---|
| v1 (stub formula) | Meeus low-precision, no angle reduction | ±16.2 min |
| **v2 (this)** | exact Kepler solve + equation of centre + aberration + nutation, calibrated | **±8.8 min** |

The single most important instant — 2024 立春, where the year pillar turns — is
computed as `16:24:41` CST against the published `16:26:53`: **−2.2 min**.

Consequence: a birth within ~±8 minutes of a 節 or 立春 instant may resolve the
year or month pillar the wrong way. `boundaryUncertainty` flags that window rather
than guessing. Everything else — the day count, the hour branch, the 五虎遁/五鼠遁
stems — is exact and verified against external anchors.

### Why it is not better yet

The residual is not concentrated in one place, which is why a bigger fudge factor
would not help (the sweep is tabulated in `astro.mjs`). The remaining sources are:

* the abridged perturbation model (Moon/Jupiter/Venus short-period terms). The
  physically-correct amplitudes are ≤ ~0.006°, i.e. up to ~2 min. **My attempts to
  add them made accuracy worse**, so they are omitted rather than included with
  guessed signs — the ablation is recorded in the constant's comment.
* a small empirical bias, removed by `CALIBRATION_OFFSET_DEG` (documented,
  measured against two independent published tables, and bounded by a test).
* possible error in the reference tables themselves, which I could not resolve
  because I could not reach an authoritative table with a stated uncertainty.

A proper fix is a truncated **VSOP87D** series for Earth's longitude. I attempted
this and got the coefficient transcription wrong (off by ~7°), so it is **not**
shipped: a wrong series silently masquerading as high precision would be worse
than an honestly-labelled reduced model. That is the recommended next step, with
coefficients taken from a verified source rather than reconstructed from memory.

---

## Domain rules implemented

1. **Local → UTC** via `Intl` (host ICU tzdata is the single source of truth for
   historical DST). No `Date.parse` on a bare local string.
   *DST gap* (spring forward): shifted **forward by the gap** — `02:30` becomes
   `03:30`. *DST overlap* (autumn fall-back): the **first** occurrence.
   In every branch `utcOffsetMinutes` provably describes `instantUtc`.
2. **Solar terms** from the Sun's apparent geocentric longitude (see `astro.mjs`).
   The 12 **節** that govern months are at λ = 315, 345, 15, 45, 75, 105, 135,
   165, 195, 225, 255, 285.
3. **Year pillar** turns at the **立春 instant** — never at 1 January and never at
   lunar new year. `(year − 4) mod 10` / `mod 12`, so 1984 = 甲子.
4. **Month pillar** turns at each 節 instants. Branches run 寅→丑 from 立春; the
   寅-month stem follows **五虎遁** from the year stem
   (甲/己→丙, 乙/庚→戊, 丙/辛→庚, 丁/壬→壬, 戊/癸→甲).
5. **Day pillar** is one continuous sexagenary count, +1 per civil day with no
   exceptions, anchored and multi-source-verified (see REFERENCES.md).
   Under `dayBoundary:'zi-chu'` the count advances at **23:00** local instead of
   midnight; note the advance happens once, so 23:30 belongs to the next day and
   00:00 belongs to that same day.
6. **Hour pillar**: branch from the two-hour windows (子 = 23:00–00:59 …); stem by
   **五鼠遁** from the day stem (甲/己→甲, 乙/庚→丙, 丙/辛→戊, 丁/壬→庚, 戊/癸→壬).
7. **Derived**: five-element counts over the four stems and four branches, plus a
   separate 藏干 (hidden-stem) tally.
8. **True solar time** (`useTrueSolarTime`): longitude correction at 4 min/degree
   from the zone's standard meridian **plus** the equation of time. When the flag
   is off, `trueSolarTime` is `false` and the correction is `0` — never faked.

---

## Limitations and gaps (`todos` in `Facts`)

* **Solar-term accuracy** is ±~8 min, not the ≤1 min target. Solar-term instants
  carry this error; all other pillars are exact.
* **No lunar-calendar input.** `calendar:'lunar'` throws `INVALID_LUNAR_DATE`.
  A solar/lunar mix-up silently yields a chart for the wrong day, which the user
  cannot detect from the prose, so refusing is the only safe behaviour.
* **No 十神, 納音, 神煞, 大運/流年, or unknown-hour charts.** `time` is required;
  `time: null` throws `BIRTH_TIME_REQUIRED`.
* **Supported range is 1900–2100**; dates outside throw `INVALID_DATE`.
* **Historical DST** (including China 1986–1991) is whatever the runtime's ICU
  tzdata carries. **Observed on the bundled Node v24.21.0 runtime:**

  | year | `Asia/Shanghai` summer (Jul) | winter (Jan) |
  |---|---|---|
  | 1986–1991 | +540 min (UTC+9) | +480 min (UTC+8) |
  | 1992 | +480 min | +480 min |

  So ICU *does* carry China's 1986–1991 DST, and it correctly stops after 1991.
  `test/boundaries.test.mjs` records this by observation rather than asserting a
  remembered answer, so a tzdata change shows up as changed output, not a pass.
* **藏干 variants**: the mainstream reading is used. A few branches (notably 辰/戌
  and 丑/未) have variant residual stems in some traditions; the kernel exposes
  which stems it counted `derived.hiddenStemElementCounts` so a disagreement is
  visible rather than hidden.
* **ΔT** uses the Espenak–Meeus polynomial chain; the pre-1972 branch is explicit
  about being an approximation (error ≤ a few seconds).

---

## Tests

```bash
cd build/kernel && "$NODE" --test 'test/*.test.mjs'
```

| File | Covers |
|---|---|
| `test/astro.test.mjs` | Meeus Example 25.a (0.0004°), monotonicity over a year, measured accuracy vs the published tables, solver determinism and no-wrong-year regression, ΔT, equation of time |
| `test/pillars.test.mjs` | 200-year +1/day walk and 60-day closure, (year−4) mod 10/12, 五虎遁, 五鼠遁, hour windows, 藏干 structure |
| `test/anchors.test.mjs` | The five external day-pillar anchors, the hand tie-out 1949→2000, full 八字 cross-checks for 1949 and 1911 |
| `test/boundaries.test.mjs` | Year pillar at 立春, month pillar at every 節, hour turns, 23:00 under both conventions, DST gap/overlap, China DST observation, true solar time, typed errors, purity |

Regression note: two solver bugs were found and fixed during development, and each
now has a dedicated test — (a) `L0`/`M` were not reduced modulo 360 before the
Kepler solve, and (b) the root-finder's scan grid was anchored to the caller's
guess, making the answer depend on the guess's phase. Do not remove those tests.

---

## Files

```
build/kernel/
├── index.mjs        public API, Facts assembly, timezone handling
├── astro.mjs        apparent solar longitude, solar-term instants, ΔT, EoT
├── pillars.mjs      sexagenary day/year/month/hour, elements, 藏干
├── README.md        this file
├── REFERENCES.md    every external anchor with its source URL
└── test/
    ├── astro.test.mjs
    ├── pillars.test.mjs
    ├── anchors.test.mjs
    └── boundaries.test.mjs
```
