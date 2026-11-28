// The crosshair and box of a range tab's chart over time on hover: the Spend tab's cost chart at
// the range Week, reached by pressing Spend, then Week. The page runs in headless Chrome on the
// stand-in for Orca (test/page/helpers/), whose worker answers the Spend tab a test sets
// (test/page/helpers/answers.ts). The pointer rests over a point at the x its chart draws it at.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SpendView } from '../../src/protocol.ts';
import { answersOf, card, FIX } from './helpers/answers.ts';
import { crosshairAt, hoverTime } from './helpers/charts.ts';
import { openPanel } from './helpers/page.ts';

// The local start of the day `day` of November 2026.
const november = (day: number) => new Date(2026, 10, day).getTime();

// The week to 28 November 2026, whose 27th cost 2.00 USD.
const WEEK: SpendView = {
  cost: 2,
  tokens: 300,
  calls: 3,
  chart: [22, 23, 24, 25, 26, 27, 28].map((day) => ({ key: `2026-11-${day}`, v: day === 27 ? 2 : 0 })),
};

test('Box of the Week cost chart', async () => {
  const { page } = await openPanel(answersOf(() => ({ cards: [card(FIX)] }), { week: WEEK }));
  await page.locator('[data-press="tab:spend"]').click();
  await page.locator('[data-press="range:week"]').click();
  await page.locator('svg[data-chart="range-cost"]').waitFor();

  await hoverTime(page, 'range-cost', november(27));

  const { crosshairs, boxes } = await crosshairAt(page, 'range-cost', november(27));
  assert.deepEqual(crosshairs, [november(27)]);
  assert.deepEqual(
    boxes.map(({ lines }) => lines),
    [['27 November', '$2.00']],
  );
});
