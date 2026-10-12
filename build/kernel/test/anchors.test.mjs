/**
 * anchors.test.mjs — the external ground truth for the day-pillar count.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The day pillar is a single continuous sexagenary count. Get its anchor wrong by
 * one day and every chart in the product is silently wrong by one day — there is
 * no internal consistency check that can catch it, because a uniformly shifted
 * count is still perfectly self-consistent. The only defence is to pin the anchor
 * against values that were published by someone else.
 *
 * Each row below was read off a public almanac page, and the pages were cross-
 * checked against each other. They are NOT derived from this kernel. The source
 * URLs are in REFERENCES.md.
 *
 * Two of the rows are deliberately chosen because the calendar is unusual there:
 *   1911-10-10 is the Xinhai revolution date (辛亥年 戊戌月 癸丑日), and it sits
 *     before the Gregorian calendar was adopted in China;
 *   1949-10-01 is the PRC founding date (己丑年 癸酉月 甲子日) and is the anchor
 *     used by the public "中国历法公共数据集" (Zenodo) day-correspondence table.
 *
 * @module test/anchors.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { dayCycleIndex, yearCycleIndex, monthPillar, hourPillar, pillarFromIndices } from '../pillars.mjs';

/**
 * Published day pillars. `stem`/`branch` are the *expected* ASCII pinyin values.
 * `timezone`/`time` record the civil date the almanac page is describing.
 */
const DAY_ANCHORS = [
  { date: '1911-10-10', ganzhi: 'gui-chou', source: '911cha 老黄历: 辛亥年 戊戌月 癸丑日' },
  { date: '1949-10-01', ganzhi: 'jia-zi', source: '911cha + ximizi.net: 己丑年 癸酉月 甲子日' },
  { date: '1984-02-02', ganzhi: 'bing-yin', source: '911cha 老黄历 (农历正月初一): 癸亥年 乙丑月 丙寅日' },
  { date: '2000-01-01', ganzhi: 'wu-wu', source: '3169.net + sheup.org: 己卯年 丙子月 戊午日' },
  { date: '2024-01-01', ganzhi: 'jia-zi', source: '911cha 老黄历' },
];

test('anchors: published day pillars reproduce from the single anchor', () => {
  for (const a of DAY_ANCHORS) {
    const [y, m, d] = a.date.split('-').map(Number);
    const idx = dayCycleIndex(y, m, d);
    const p = pillarFromIndices(idx % 10, idx % 12);
    assert.equal(p.ganzhi, a.ganzhi, `${a.date}: expected ${a.ganzhi}, got ${p.ganzhi} [${a.source}]`);
  }
});

test('anchors: the anchor constant itself is the documented one', () => {
  // 1949-10-01 = 甲子 (cycle index 0). If someone "fixes" the anchor, this fails
  // loudly rather than quietly shifting every chart by some number of days.
  assert.equal(dayCycleIndex(1949, 10, 1), 0, 'PRC founding day must be cycle index 0 (甲子)');
  // And 60 days later must be the same pillar.
  assert.equal(dayCycleIndex(1949, 11, 30), 0);
});

test('anchors: the four independent sources agree with each other', () => {
  // The real content of the anchor claim: four dates from three different public
  // sources must be mutually consistent under ONE constant. If the anchor were
  // wrong, these would disagree by a fixed offset.
  const idx1949 = dayCycleIndex(1949, 10, 1);
  const idx2000 = dayCycleIndex(2000, 1, 1);
  // Hand-derivable tie-out, no kernel arithmetic involved:
  //   1949-10-01 -> 2000-01-01 is 18354 days (51y*365 + 13 leap days - 274 days),
  //   18354 mod 60 = 54, and 甲子(0) + 54 = index 54 = 戊午.
  const days = Math.round((Date.UTC(2000, 0, 1) - Date.UTC(1949, 9, 1)) / 86400000);
  assert.equal(days, 18354);
  assert.equal((idx1949 + days) % 60, idx2000);
  assert.equal(idx2000, 54, '2000-01-01 must be cycle index 54 (戊午)');
});

test('anchors: day-pillar day-of-week sanity (independently known weekday)', () => {
  // 1949-10-01 was a Saturday; 2000-01-01 was a Saturday; 1911-10-10 was a Tuesday.
  // A weekday check does not test the ganzhi anchor, but it does catch a civil-day
  // counter that is off by whole weeks, which would otherwise hide inside mod 60.
  assert.equal(new Date(Date.UTC(1949, 9, 1)).getUTCDay(), 6);
  assert.equal(new Date(Date.UTC(2000, 0, 1)).getUTCDay(), 6);
  assert.equal(new Date(Date.UTC(1911, 9, 10)).getUTCDay(), 2);
});

test('anchors: 1949-10-01 year/month/hour agree with the published chart', () => {
  // 911cha and ximizi.net both give the full 八字 for 1949-10-01 as
  //   己丑 癸酉 甲子 甲子   (year 己丑, month 癸酉, day 甲子, hour 甲子 at 子时).
  // This exercises the month-stem rule (五虎遁) and the hour-stem rule (五鼠遁)
  // against an external source, not just the day count.
  const baziYear = 1949;                 // after 立春 1949
  const yIdx = yearCycleIndex(baziYear);
  const yearP = pillarFromIndices(yIdx % 10, yIdx % 12);
  assert.equal(yearP.ganzhi, 'ji-chou');

  // 1949-10-01 is in the 酉 month, which is ordinal 8 counting 寅=1.
  const monthP = monthPillar(yIdx % 10, 8);
  assert.equal(monthP.ganzhi, 'gui-you');

  const dayIdx = dayCycleIndex(1949, 10, 1);
  assert.equal(pillarFromIndices(dayIdx % 10, dayIdx % 12).ganzhi, 'jia-zi');

  // 子时 (23:00-00:59) on a 甲 day: 五鼠遁 甲/己 -> 甲子.
  assert.equal(hourPillar(dayIdx % 10, 23).ganzhi, 'jia-zi');
  assert.equal(hourPillar(dayIdx % 10, 0).ganzhi, 'jia-zi');
});

test('anchors: 1911-10-10 also matches its published year and month', () => {
  // 911cha: 辛亥年 戊戌月 癸丑日 for 1911-10-10 (after 立春, in the 戌 month).
  const yIdx = yearCycleIndex(1911);
  assert.equal(pillarFromIndices(yIdx % 10, yIdx % 12).ganzhi, 'xin-hai');
  const monthP = monthPillar(yIdx % 10, 9); // 戌 is ordinal 9 counting 寅=1
  assert.equal(monthP.ganzhi, 'wu-xu');
});
