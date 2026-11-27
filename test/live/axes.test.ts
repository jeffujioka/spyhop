// The values on the axes of the live panel's four charts (src/live/charts.ts): faint lines at
// zero, one and two round steps of each chart's scale, those at one and two steps labelled inside
// the chart at its left, and the times of day under each chart at round marks, or under every
// n-th bar of the tokens chart. Drawn from the real worker's fleet and session answers over omp
// session files under a temporary home (test/helpers/live.ts), and read through the markup's
// conventions (test/helpers/markup.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCostPerHour } from '../../src/core/format.js';
import { contextChart, costChart, tokensChart } from '../../src/live/charts.ts';
import { MINUTE } from '../core/helpers/entries.ts';
import { NOW } from '../helpers/agent-cards.ts';
import { at, burnOf, ompView, spent } from '../helpers/live.ts';
import { attr, parts, text } from '../helpers/markup.ts';

// The values of a chart's faint lines, the texts of its labels, which sit in its plot, laid over
// it, and the texts of its times with each time's epoch ms and its place from the left, a percent.
function axesOf(chart: string) {
  const [plot] = parts(chart, 'data-part', 'plot');
  const [svg] = parts(plot, 'data-chart');
  const [times] = parts(chart, 'data-part', 'times');
  return {
    lines: parts(svg, 'data-scale').map((line) => Number(attr(line, 'data-scale'))),
    labels: parts(plot, 'data-label').map((label) => [Number(attr(label, 'data-label')), text(label)]),
    times: parts(times, 'data-time').map((time) => ({ text: text(time), t: Number(attr(time, 'data-time')), left: Number(/left:([\d.]+)%/.exec(attr(time, 'style')!)![1]) })),
  };
}

test('Round scale of the burn rate chart', async () => {
  // 7.30 USD per hour over the last 10 minutes
  const { answer, burn } = await burnOf([{ title: 'a', calls: [spent(7.3 / 6, NOW - 5 * MINUTE)] }]);

  const { layers } = answer.burn;
  assert.notEqual(layers, 'n/a');
  if (layers === 'n/a') return;
  const highest = Math.max(...layers[0].values.map((_, i) => layers.reduce((sum, { values }) => sum + values[i], 0)));
  assert.equal(formatCostPerHour(highest), '$7.30/h');
  const { lines, labels } = axesOf(burn);
  assert.deepEqual(lines, [0, 5, 10]);
  assert.deepEqual(labels, [
    [5, '$5.00/h'],
    [10, '$10.00/h'],
  ]);
});

test('Context chart from 0% to 100%', async () => {
  const contexts = [200_000, 730_000, 500_000];
  const session = await ompView({ calls: contexts.map((context, i) => ({ at: at(`10:0${i}`), uncached: context, output: 10, context })) });

  const chart = contextChart(session.context!);
  const { lines, labels } = axesOf(chart);
  assert.deepEqual(lines, [0, 0.5, 1]);
  assert.deepEqual(labels, [
    [0.5, '50%'],
    [1, '100%'],
  ]);
  assert.equal(parts(chart, 'data-ref', '0.75').length, 1);
  assert.equal(parts(chart, 'data-ref', '0.9').length, 1);
});

test('Scale of the prompt tokens', async () => {
  const session = await ompView({
    calls: [
      { at: at('10:00'), read: 100_000, write: 50_000, uncached: 30_000, output: 900 },
      { at: at('10:01'), read: 20_000, uncached: 1000, output: 300 },
    ],
  });

  const { lines, labels } = axesOf(tokensChart(session.tokens!));
  assert.deepEqual(lines, [0, 100_000, 200_000]);
  assert.deepEqual(labels, [
    [100_000, '100k'],
    [200_000, '200k'],
  ]);
});

test('Times at round marks', async () => {
  // the clock reads 12:48: the chart spans the minutes 11:49 to 12:48
  const now = at('12:48') + 30_000;
  const { answer, burn } = await burnOf([{ title: 'a', calls: [spent(1, now - 5 * MINUTE)] }], { now });

  // the worker's answer gives the newest minute's time
  assert.equal(answer.burn.endMs, at('12:48'));
  const { times } = axesOf(burn);
  assert.deepEqual(
    times.map(({ text }) => text),
    ['12:00', '12:15', '12:30', '12:45'],
  );
  // each under its minute: the minute's x on the chart, the first of its 60 at 11:49
  const [layer] = parts(burn, 'data-layer');
  const minuteXs = [...attr(parts(layer, 'd')[0], 'd')!.matchAll(/[ML]([\d.]+) /g)].map(([, x]) => Number(x)).slice(0, 60);
  for (const { t, left } of times) {
    assert.equal(new Date(t).getUTCSeconds(), 0);
    assert.ok(Math.abs(left - (minuteXs[(t - at('11:49')) / MINUTE] / 360) * 100) < 0.01, `${left}% under its minute`);
  }
});

test('Times under the tokens chart', async () => {
  const clock = ['10:00', '10:01', '10:03', '10:10', '10:11', '10:30', '10:31', '10:32', '10:50'];
  const session = await ompView({ calls: clock.map((hhmm) => ({ at: at(hhmm), uncached: 1000, output: 10 })) });

  const chart = tokensChart(session.tokens!);
  const { times } = axesOf(chart);
  assert.deepEqual(
    times.map(({ text }) => text),
    ['10:00', '10:03', '10:11', '10:31', '10:50'],
  );
  // each under its bar: the first, third, fifth, seventh and ninth
  const bars = parts(chart, 'data-bar');
  times.forEach(({ left }, i) => {
    const [rect] = parts(bars[i * 2], 'class');
    const centre = Number(attr(rect, 'x')) + Number(attr(rect, 'width')) / 2;
    assert.ok(Math.abs(left - (centre / 360) * 100) < 0.01, `${left}% under its bar`);
  });
});

test('Time marks of a span under one minute', async () => {
  // no whole minute in the span: its first and last times, which read alike, written once
  const session = await ompView({ calls: [10, 50].map((seconds) => ({ at: at('10:00') + seconds * 1000, uncached: 1000, output: 10, context: 1000, cost: 0.1 })) });

  assert.deepEqual(
    axesOf(contextChart(session.context!)).times.map(({ text }) => text),
    ['10:00'],
  );
  assert.deepEqual(
    axesOf(costChart(session.cost!)).times.map(({ text }) => text),
    ['10:00'],
  );
});

test('Cost labels under a cent', async () => {
  // $0.004 spent in all: a step of $0.002
  const session = await ompView({
    calls: [
      { at: at('10:00'), uncached: 1000, output: 10, cost: 0.001 },
      { at: at('10:01'), uncached: 1000, output: 10, cost: 0.003 },
    ],
  });

  const { lines, labels } = axesOf(costChart(session.cost!));
  assert.deepEqual(lines, [0, 0.002, 0.004]);
  assert.deepEqual(labels, [
    [0.002, '$0.002'],
    [0.004, '$0.004'],
  ]);
});
