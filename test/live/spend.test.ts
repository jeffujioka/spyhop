// The Spend tab's cost, tokens and model calls over a range, its cost over time, its cost by repo,
// model and harness, the side calls' cost and where the cost comes from: the real worker's answer
// from the history store, which its first catch-up filled from omp session files under a
// temporary home (test/helpers/history.ts), drawn and read through the markup's conventions
// (test/helpers/markup.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { setEnv } from '../helpers/env.ts';
import { rangeOf } from '../helpers/history.ts';
import { ompSession, spent, type OmpCall } from '../helpers/live.ts';
import { attr, figure, listOf, parts, text } from '../helpers/markup.ts';
import { withCopilotPrices } from '../helpers/prices.ts';

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
  assert.equal(figures.length, 9);
  for (const titled of figures) {
    assert.notEqual(text(parts(titled, 'data-title')[0] ?? ''), '', titled);
    assert.notEqual(text(parts(titled, 'data-meaning')[0] ?? ''), '', titled);
  }
  for (const name of ['cost', 'tokens', 'calls', 'sideCost']) assert.equal(figures.filter((titled) => figure(titled, name) !== undefined).length, 1, name);
  assert.equal(figures.filter((titled) => costChartOf(titled) !== undefined).length, 1);
});

// Epoch ms of `hhmm` UTC on the tests' day, 2026-11-28.
const today = (hhmm: string) => Date.parse(`2026-11-28T${hhmm}:00.000Z`);

// Writes, for each repo of `costs`, an omp session in a git folder whose origin is that repo,
// which logs one model call of its cost at 12:00 UTC on 2026-11-27.
const reposSpent = (costs: Record<string, number>) => (home: string) =>
  Object.entries(costs).forEach(([repo, usd], i) => {
    const folder = join(home, `repo-${i}`);
    ompSession(home, folder, { title: repo, calls: [spent(usd, Date.parse('2026-11-27T12:00:00.000Z'))] });
    execFileSync('git', ['init', '-q'], { cwd: folder });
    execFileSync('git', ['remote', 'add', 'origin', repo], { cwd: folder });
  });

test('Eight repos', async () => {
  const costs = { r1: 8, r2: 7, r3: 6, r4: 5, r5: 4, r6: 3, r7: 2, r8: 1 };
  const { html } = await rangeOf([], { tab: 'spend', range: 'week', now: CLOCK, prepare: reposSpent(costs) });

  assert.deepEqual(listOf(html, 'repo'), ['r1 $8.00', 'r2 $7.00', 'r3 $6.00', 'r4 $5.00', 'r5 $4.00', 'r6 $3.00', 'others $3.00']);
  assert.deepEqual(listOf(html, 'harness'), ['omp $36.00']);
});

test('a repo with markup is shown as text', async () => {
  const { html } = await rangeOf([], { tab: 'spend', range: 'week', now: CLOCK, prepare: reposSpent({ 'a<b&c': 1 }) });

  assert.deepEqual(listOf(html, 'repo'), ['a<b&c $1.00']);
  assert.match(parts(html, 'data-list', 'repo')[0], /a&lt;b&amp;c/);
});

test('Side calls on the Spend tab', async () => {
  const opus = { provider: 'anthropic', model: 'claude-opus-5.5', output: 100 };
  const haiku = { provider: 'anthropic', model: 'claude-haiku-5.5', output: 100 };
  const calls: OmpCall[] = [
    { ...opus, at: today('10:00'), cost: 0.5 },
    { ...haiku, at: today('10:00') + 1, side: 'title-fork', cost: 0.04 },
    { ...opus, at: today('11:00'), cost: 0.75 },
    { ...opus, at: today('12:00'), cost: 0.75 },
    { ...haiku, at: today('13:00'), side: 'recap', cost: 0.02 },
  ];
  const { html } = await rangeOf([], { tab: 'spend', range: 'day', now: CLOCK, prepare: (home) => ompSession(home, join(home, 'api'), { title: 'api', calls }) });

  assert.equal(figure(html, 'cost'), '$2.06');
  assert.equal(figure(html, 'sideCost'), '$0.06');
  assert.deepEqual(listOf(html, 'model'), ['anthropic/claude-opus-5.5 $2.00', 'anthropic/claude-haiku-5.5 $0.06']);
  // no Copilot part: the cost says nothing of where it comes from
  assert.doesNotMatch(text(html), /GitHub prices|logged it/);
});

// A guard of where the Spend tab's cost comes from, no scenario of the spec: with a Copilot call,
// which the table prices at 0.25 USD, and one through `anthropic` that logged 0.40 USD, the cost
// says which part is which.
test('the Spend cost says where a Copilot part comes from', async () => {
  withCopilotPrices({ 'claude-opus-5.5': { input: 500, cachedInput: 50, cacheWrite: 625, output: 2500, tiers: [] } });
  const calls: OmpCall[] = [
    { at: today('10:00'), provider: 'github-copilot', model: 'claude-opus-5.5', uncached: 10_000, read: 100_000, write: 16_000, output: 2_000, cost: 0.9 },
    { at: today('11:00'), provider: 'anthropic', model: 'claude-opus-5.5', uncached: 1_000, output: 100, cost: 0.4 },
  ];
  const { html } = await rangeOf([], { tab: 'spend', range: 'day', now: CLOCK, prepare: (home) => ompSession(home, join(home, 'api'), { title: 'api', calls }) });

  assert.equal(figure(html, 'cost'), '$0.65');
  assert.match(text(html), /\$0\.25 from tokens at GitHub prices/);
  assert.match(text(html), /\$0\.40 as the harness logged it/);
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

test('Cost labels under a cent over a range', async () => {
  // $0.004 on the top day: a step of $0.002, labelled as Live's cost chart labels it
  const { html } = await rangeOf([], { tab: 'spend', range: 'week', now: CLOCK, prepare: spentOn({ '2026-11-27': 0.001, '2026-11-28': 0.004 }) });

  // the tab's one plot, whose labels are laid over its chart
  const [plot] = parts(html, 'data-part', 'plot');
  const labels = parts(plot, 'data-label').map((label) => [Number(attr(label, 'data-label')), text(label)]);
  assert.deepEqual(labels, [
    [0.002, '$0.002'],
    [0.004, '$0.004'],
  ]);
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
