// The tab bar of the live panel, as markup: Live, then the range tabs Spend, Cache and Health, the
// shown one selected; on a range tab, the range control under it, the shown range pressed.
// Pure: no DOM.

import type { Range, RangeAnswer, RangeTab } from '../protocol.ts';
import { cacheTab } from './cache.ts';
import { spendTab } from './spend.ts';

const TABS = [
  ['live', 'Live'],
  ['spend', 'Spend'],
  ['cache', 'Cache'],
  ['health', 'Health'],
] as const;

const RANGES = [
  ['day', 'Day'],
  ['week', 'Week'],
  ['month', 'Month'],
  ['year', 'Year'],
] as const;

// The tab bar with `tab` shown and, when `range` is given, the range control with it pressed.
export function tabBar(tab: 'live' | RangeTab, range: Range | null): string {
  const tabs = TABS.map(([name, label]) => `<button data-press="tab:${name}" role="tab" aria-selected="${name === tab}">${label}</button>`).join('');
  const ranges = range === null ? '' : `<div data-part="range" class="row">${RANGES.map(([name, label]) => `<button data-press="range:${name}" aria-pressed="${name === range}">${label}</button>`).join('')}</div>`;
  return `<nav data-part="tabs" class="row" role="tablist">${tabs}</nav>${ranges}`;
}

// The body of the range tab `answer` is of, under its tab bar: the Spend or the Cache tab; the
// Health tab has none yet.
export const tabBody = (answer: RangeAnswer): string => (answer.tab === 'spend' ? spendTab(answer) : answer.tab === 'cache' ? cacheTab(answer) : '');
