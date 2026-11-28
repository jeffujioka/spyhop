// The Spend tab's cost, tokens and model calls over a range, and its cost over time: the real
// worker's answer from the history store, which its first catch-up filled from omp session files
// under a temporary home (test/helpers/history.ts), drawn and read through the markup's
// conventions (test/helpers/markup.ts).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { setEnv } from '../helpers/env.ts';
import { rangeOf } from '../helpers/history.ts';
import { ompSession, spent } from '../helpers/live.ts';
import { attr, figure, parts, text } from '../helpers/markup.ts';

// The clock of these tests: 2026-11-28 15:00, in UTC unless a test sets another time zone.
const CLOCK = Date.parse('2026-11-28T15:00:00.000Z');

// Writes an omp session under the home that logs one model call of each cost of `costs` at 12:00
// UTC of its day (YYYY-MM-DD).
const spentOn = (costs: Record<string, number>) => (home: string) =>
  ompSession(home, join(home, 'api'), { title: 'api', calls: Object.entries(costs).map(([day, usd]) => spent(usd, Date.parse(`${day}T12:00:00.000Z`))) });

// The cost chart over time of the Spend tab `html`, undefined when it has none.
const costChartOf = (html: string) => parts(html, 'data-chart', 'range-cost')[0];

// Each point of the chart `chart`: its key and its value.
const pointsOf = (chart: string) => parts(chart, 'data-key').map((point) => [attr(point, 'data-key'), Number(attr(point, 'data-v'))]);

test('Week by day', async () => {
  const { html } = await rangeOf([], {
    tab: 'spend',
    range: 'week',
    now: CLOCK,
    prepare: spentOn({ '2026-11-21': 9, '2026-11-22': 1, '2026-11-27': 2, '2026-11-28': 0.5 }),
  });

  assert.deepEqual(pointsOf(costChartOf(html)), [
    ['2026-11-22', 1],
    ['2026-11-23', 0],
    ['2026-11-24', 0],
    ['2026-11-25', 0],
    ['2026-11-26', 0],
    ['2026-11-27', 2],
    ['2026-11-28', 0.5],
  ]);
  assert.equal(figure(html, 'cost'), '$3.50');
  // every figure and chart under its title and the line of what it means
  const figures = parts(html, 'data-part', 'figure');
  assert.equal(figures.length, 4);
  for (const titled of figures) {
    assert.notEqual(text(parts(titled, 'data-title')[0] ?? ''), '', titled);
    assert.notEqual(text(parts(titled, 'data-meaning')[0] ?? ''), '', titled);
  }
  for (const name of ['cost', 'tokens', 'calls']) assert.equal(figures.filter((titled) => figure(titled, name) !== undefined).length, 1, name);
  assert.equal(figures.filter((titled) => costChartOf(titled) !== undefined).length, 1);
});

test('Year by month', async () => {
  const { html } = await rangeOf([], {
    tab: 'spend',
    range: 'year',
    now: CLOCK,
    prepare: spentOn({ '2025-11-20': 5, '2025-12-20': 1, '2026-01-20': 2, '2026-11-20': 3 }),
  });

  const points = pointsOf(costChartOf(html));
  assert.deepEqual(
    points.map(([key]) => key),
    ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'],
  );
  assert.deepEqual(points.map(([, v]) => v), [1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
  assert.equal(figure(html, 'cost'), '$6.00');
});

test('Day without a chart over time', async () => {
  const { html } = await rangeOf([], { tab: 'spend', range: 'day', now: CLOCK, prepare: spentOn({ '2026-11-27': 2, '2026-11-28': 0.5 }) });

  assert.equal(figure(html, 'cost'), '$0.50');
  assert.equal(costChartOf(html), undefined);
});

test("Day of this computer's time zone", async () => {
  const { html } = await rangeOf([], {
    tab: 'spend',
    range: 'week',
    // 15:00 in Berlin, an hour ahead of UTC in November
    now: Date.parse('2026-11-28T14:00:00.000Z'),
    prepare: (home) => {
      setEnv('TZ', 'Europe/Berlin');
      ompSession(home, join(home, 'api'), { title: 'api', calls: [spent(1, Date.parse('2026-11-27T23:30:00.000Z'))] });
    },
  });

  const chart = costChartOf(html);
  const points = Object.fromEntries(pointsOf(chart));
  assert.equal(points['2026-11-28'], 1);
  assert.equal(points['2026-11-27'], 0);
  // each point at the start of its day in Berlin
  assert.equal(attr(parts(chart, 'data-key', '2026-11-28')[0], 'data-t'), String(Date.parse('2026-11-27T23:00:00.000Z')));
});
