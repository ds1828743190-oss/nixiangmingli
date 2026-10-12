# REFERENCES.md — external anchors and what each one proves

Every number this kernel depends on from the outside world is listed here with the
URL it came from and the specific claim it supports. Nothing in this file is
derived from the kernel's own output.

Two categories matter, and they are deliberately kept apart:

1. **Day-pillar anchors** — the one constant that silently corrupts every chart if
   it is wrong.
2. **Solar-term instants** — the basis for the year (立春) and month (節) boundaries,
   and the source of this kernel's *measured* accuracy figure.

---

## 1. Day-pillar anchors

The kernel anchors the continuous sexagenary day count on a single constant
(`DAY_ANCHOR` in `pillars.mjs`): **1949-10-01 = 甲子日**, cycle index 0.
The rows below were read off public almanac pages and are mutually consistent
under that one constant.

| Date (civil, local) | Day pillar | Expected `ganzhi` | Source |
|---|---|---|---|
| 1911-10-10 | 癸丑 | `gui-chou` | [911cha 老黄历](https://mipnongli.911cha.com/1911-10-10.html) — "辛亥年 戊戌月 癸丑日" |
| 1949-10-01 | 甲子 | `jia-zi` | [911cha 老黄历](https://mipnongli.911cha.com/1949-10-1.html) — "己丑年 癸酉月 甲子日"; independently [ximizi.net](https://ximizi.net/huangli/1949/1949-10-1jishi.html) — "己丑年 癸酉月 甲子日" |
| 1984-02-02 | 丙寅 | `bing-yin` | [911cha 老黄历](https://mipnongli.911cha.com/1984-2-2.html) (農曆正月初一) |
| 2000-01-01 | 戊午 | `wu-wu` | [3169.net 黄历](http://m.3169.net/hl/2000-1-1.html) — "己卯年 丙子月 戊午日"; independently [sheup.org](https://sheup.org/minfo/huangli2000/2000-1-1.html) — "己卯年 丙子月 戊午日" |
| 2024-01-01 | 甲子 | `jia-zi` | [911cha 老黄历](https://mipnongli.911cha.com/2024-1-1.html) |

### What these prove

* **Five dates from four independent sites** agree under one constant, so the
  anchor is over-determined. A wrong constant would make them disagree by a fixed
  offset. `test/anchors.test.mjs` asserts all five.
* **1949-10-01 → 2000-01-01 is 18 354 days** and `18354 mod 60 = 54`, so
  index 0 (甲子) + 54 = index 54 = 戊午. That tie-out is written out by hand in
  `test/anchors.test.mjs` and does not use kernel arithmetic.
* **The year, month and hour rules are pinned separately** by the published full
  charts (八字) on the 1949 and 1911 pages: 己丑年 癸酉月 甲子日 甲子時 and
  辛亥年 戊戌月 癸丑日. These exercise 五虎遁 (month stem) and 五鼠遁 (hour stem),
  not just the day count.

### A source whose own printed Julian Day is wrong (recorded for honesty)

The 911cha pages also print a "儒略日" (Julian Day) value. For **1949-10-01** it
prints `2433196.5`, but the correct JDN is `2433191` (JD 2433191.5 = 1949-10-01
00:00 UT). The three other pages agree with the standard value. The day-pillar
values are used here; **the printed Julian Days are not**, and this discrepancy is
called out so a future reader does not "fix" the JDN arithmetic to match a wrong
page.

---

## 2. Solar-term instants (accuracy baseline)

These are used only to *measure* the model in `test/astro.test.mjs`; the kernel
computes its own instants and never reads a table at runtime.

| Source | What it gives | Use |
|---|---|---|
| [tool.ljgw.cn 二十四节气查询](https://tool.ljgw.cn/toolbox/ershisijieqi/2024.html) ([2025](https://tool.ljgw.cn/toolbox/ershisijieqi/2025.html)) | All 24 節氣 for 2024 and 2025, Beijing time, to the **second** | 50-point accuracy set (節 + 中氣) |
| [rili.com.cn 二十四节气时间表 2020–2035](https://m.rili.com.cn/24jieqi/71169.html) | 2020–2035 節氣, Beijing time | 11 立春 instants 2020–2030; the baseline the parent audit (`build/verify/kernel-accuracy.md`) used |
| [NAOJ 暦要項 2024](http://eco2.mtk.nao.ac.jp/koyomi/yoko/2024/rekiyou242.html) | Japan's national almanac: each 節氣 with its solar longitude and time (JST, to the minute) | Independent cross-check that ljgw.cn's values are not idiosyncratic |
| [wannianli.tianqi.com 2024 立春](https://wannianli.tianqi.com/news/290090.html) | 2024 立春 = 2024-02-04 16:26:53 CST | Cross-check of the single most important instant (year-pillar boundary) |

### Corroboration between the tables

ljgw.cn and the NAOJ table agree on the same instants to within tens of seconds,
e.g. 2024 立春: ljgw.cn `16:27:05` CST vs NAOJ `17:27` JST (= `16:27` CST). Because
the two are produced independently in different countries, this establishes that
the reference values themselves are sound and that the kernel's disagreement with
them (below) is the kernel's.

### Measured accuracy of this kernel

Against those tables, using the real solver end to end:

| Set | n | RMS | max |
|---|---|---|---|
| 立春 2020–2030 | 11 | **3.68 min** | 7.48 min |
| 節 + 中氣 2023-12 … 2025-12 | 50 | **3.70 min** | 8.80 min |
| the 12 節 only (what moves month pillars) | 25 | **2.96 min** | 6.77 min |

The single most important row — 2024 立春, the year-pillar boundary — is computed
as `2024-02-04 16:24:41` CST against the published `16:26:53` CST: **−2.2 min**.

This is a **4.3x improvement** over the previous implementation (max ±16.2 min,
recorded in `build/verify/kernel-accuracy.md`), but it **does not meet the ≤1 min
target** that audit set. See README.md → "Measured accuracy" for the honest
statement and the options.

---

## 3. Algorithms and constants

| Item | Source |
|---|---|
| Sun's mean longitude, mean anomaly, eccentricity, equation of centre, aberration, nutation, obliquity, equation of time | Meeus, *Astronomical Algorithms*, 2nd ed., ch. 22, 25, 28. Validated against the book's **worked Example 25.a** (1992 Oct 13.0 TD): this kernel returns 199.90862° vs the printed 199.90895°, a 0.0003° difference — `test/astro.test.mjs` asserts it |
| ΔT polynomial chain | Espenak & Meeus, NASA eclipse-site polynomial expressions. Explicitly documented as approximate before 1972 |
| Leap years / civil day count | Proleptic Gregorian; verified by JDN differences, including the 1900 (not leap) / 2000 (leap) century pair |
| 干支 rules (五虎遁, 五鼠遁, 立春 year boundary, 節 month boundary, 子時 window) | Standard public calendrical rules, restated in comments beside each function and asserted rule-by-rule in `test/pillars.test.mjs` |
| 藏干 (hidden stems) | Mainstream table; the uncontested entries are asserted, and README.md lists the branches where sources vary |

---

## 4. Things I could NOT verify (stated plainly)

1. **The 2-minute target is not met.** Measured max error is 7–9 minutes. I cannot
   tell how much of the residual is the kernel and how much is the reference
   tables, because I could not obtain an authoritative table with a published
   uncertainty.
2. **No authoritative (observatory-grade) 節氣 table was reachable.** The NAOJ
   table is official but prints only whole minutes and only for 2024; the
   `hko.gov.hk` endpoints timed out and the `nao.ac.jp` PDF did not fetch.
3. **The empirical calibration constant is a documented limitation, not physics.**
   It removes a measured mean bias but the residual scatter remains.
4. **I did not confirm any published statement of the reference tables' own
   uncertainty.** The two tables agreeing to tens of seconds is suggestive, not a
   guarantee.
5. **Historical China DST (1986–1991)** depends entirely on the runtime's ICU
   tzdata; the kernel reports whatever ICU says and does not carry its own history.
   `test/boundaries.test.mjs` records the observed offsets rather than asserting a
   remembered answer.
