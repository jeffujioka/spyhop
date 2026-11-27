// The charts of the session screen (src/live/charts.ts): the context over the whole session, as a
// percent of the window coloured by level or in tokens when the window cannot be read, with its
// compactions; the tokens of each model call with the cold starts; and the cost; neighbouring
// model calls grouped to the room a chart has. Drawn from the real worker's session answer over
// session files under a temporary home (test/helpers/live.ts), and read through the markup's
// conventions (test/helpers/markup.ts).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { contextChart, costChart, tokensChart } from '../../src/live/charts.ts';
import type { SessionView } from '../../src/protocol.ts';
import { claudeSession, ompAutocompacts, ompSession, ompWindow, sessionOf, type ClaudeCall, type Compaction, type OmpCall } from '../helpers/live.ts';
import { attr, figure, parts, text, textOutsideFigures } from '../helpers/markup.ts';

// Epoch ms of `hhmm` on the day of the tests' clock (test/helpers/agent-cards.ts), in UTC, the
// time zone the tests run in.
const at = (hhmm: string) => Date.parse(`2026-11-25T${hhmm}:00.000Z`);

// The session the worker answers for one working agent of the workspace `api`/`main`, linked to
// an omp session of `calls` and `compactions`, on a window of 1,000,000 tokens when `window`,
// with omp's default autocompaction when `autocompacts`; `now`: the clock's time.
async function ompView({ calls, compactions, window = true, autocompacts = false, now }: { calls: OmpCall[]; compactions?: Compaction[]; window?: boolean; autocompacts?: boolean; now?: number }) {
  const { answer } = await sessionOf([{ project: 'api', name: 'main', agents: ['working'], title: 'π - Draw the charts' }], {
    now,
    prepare: (home) => {
      if (window) ompWindow(home, 1_000_000);
      if (autocompacts) ompAutocompacts(home);
      // in the folder Orca reports for the workspace `api`/`main` (test/helpers/orca-host.ts)
      ompSession(home, join(home, 'work/api-main', 'charts'), { title: 'Draw the charts', calls, compactions });
    },
  });
  return answer.session!;
}

// The session the worker answers for one working Claude Code agent of the workspace `web`/`main`,
// linked to a session of `calls` and `compactions`.
async function claudeView(calls: ClaudeCall[], compactions: Compaction[] = []) {
  const { answer } = await sessionOf([{ project: 'web', name: 'main', agents: ['working'], harness: 'claude' }], {
    prepare: (home) => claudeSession(home, join(home, 'work/web-main'), { calls, compactions }),
  });
  return answer.session!;
}

// The numbers of the attribute `name` of each of `elements`.
const numbers = (elements: string[], name: string) => elements.map((element) => Number(attr(element, name)));

// The points of a chart: its elements that carry a value.
const points = (chart: string) => parts(chart, 'data-v');

test('Context line coloured by level', async () => {
  const contexts = [100_000, 650_000, 800_000, 950_000];
  const times = ['10:00', '10:10', '10:20', '10:30'].map(at);
  const session = await ompView({ calls: contexts.map((context, i) => ({ at: times[i], uncached: context, output: 10, context })) });

  const chart = contextChart(session.context!);
  const [svg] = parts(chart, 'data-chart', 'context');
  assert.deepEqual(numbers(points(svg), 'data-v'), [0.1, 0.65, 0.8, 0.95]);
  assert.deepEqual(numbers(points(svg), 'data-t'), times);
  assert.deepEqual(
    points(svg).map((point) => attr(point, 'class')),
    ['lvl-ok', 'lvl-warning', 'lvl-hot', 'lvl-critical'],
  );
  assert.equal(parts(svg, 'data-ref', '0.75').length, 1);
  assert.equal(parts(svg, 'data-ref', '0.9').length, 1);
  // the lines' percents are written beside the chart, so no level is told by colour alone
  assert.match(text(chart), /75% 90%/);
  assert.doesNotMatch(svg, /<text/);
});

test('Headline of the context chart', async () => {
  // compacted twice, once from 880,000 tokens, the highest the context was
  const contexts = [500_000, 400_000, 620_000];
  const session = await ompView({
    autocompacts: true,
    calls: contexts.map((context, i) => ({ at: at(`10:${i}0`), uncached: context, output: 10, context })),
    compactions: [
      { at: at('10:05'), before: 880_000, after: 200_000 },
      { at: at('10:15'), before: 700_000, after: 150_000 },
    ],
  });

  const chart = contextChart(session.context!);
  assert.equal(figure(chart, 'latest'), '62%');
  assert.match(text(chart), /62% peak 88% · 2 compactions · 230k left/);
});

test('Context chart of a Claude Code session', async () => {
  const contexts = [100_000, 181_586, 150_000];
  const times = ['10:00', '10:10', '10:20'].map(at);
  const session = await claudeView(contexts.map((context, i) => ({ at: times[i], uncached: context, output: 10 })));

  const chart = contextChart(session.context!);
  const [svg] = parts(chart, 'data-chart', 'context');
  assert.deepEqual(numbers(points(svg), 'data-v'), contexts);
  assert.deepEqual(numbers(points(svg), 'data-t'), times);
  assert.equal(figure(chart, 'latest'), '150k');
  assert.equal(figure(chart, 'peak'), '182k');
  assert.match(attr(svg, 'class') ?? '', /\bplain\b/);
  assert.equal(parts(chart, 'data-ref').length, 0);
  assert.doesNotMatch(chart, /lvl-/);
  assert.doesNotMatch(text(chart), /%/);
  // Claude Code logs no cost per call: the session's own cost is n/a and has no line
  assert.equal(session.cost!.own, 'n/a');
  assert.equal(parts(costChart(session.cost!), 'data-layer', 'own').length, 0);
});

test('Compaction on the chart in tokens', async () => {
  const session = await claudeView(
    [
      { at: at('10:20'), uncached: 181_586, output: 10 },
      { at: at('10:30'), uncached: 27_805, output: 10 },
    ],
    [{ at: at('10:25'), before: 181_586, after: 27_805 }],
  );

  const chart = contextChart(session.context!);
  const marks = parts(chart, 'data-mark');
  assert.equal(marks.length, 1);
  assert.equal(Number(attr(marks[0], 'data-t')), at('10:25'));
  assert.equal(attr(marks[0], 'data-before'), '181586');
  assert.equal(attr(marks[0], 'data-after'), '27805');
  assert.match(text(chart), /10:25 182k → 28k/);
});

test('Compaction with its tokens before and after', async () => {
  const session = await ompView({
    now: at('13:00'),
    calls: [
      { at: at('12:30'), uncached: 880_000, output: 10, context: 880_000 },
      { at: at('12:50'), uncached: 221_000, output: 10, context: 221_000 },
    ],
    compactions: [{ at: at('12:40'), before: 880_000, after: 221_000 }],
  });

  const chart = contextChart(session.context!);
  const marks = parts(chart, 'data-mark');
  assert.equal(marks.length, 1);
  assert.equal(Number(attr(marks[0], 'data-t')), at('12:40'));
  assert.equal(attr(marks[0], 'data-before'), '880000');
  assert.equal(attr(marks[0], 'data-after'), '221000');
  assert.match(text(chart), /12:40 880k → 221k/);
});

test('One bar per model call', async () => {
  const session = await ompView({
    calls: [
      { at: at('10:00'), read: 0, write: 40_000, uncached: 10_000, output: 300 },
      { at: at('10:01'), read: 40_000, write: 10_000, uncached: 0, output: 500 },
      { at: at('10:02'), read: 50_000, write: 0, uncached: 0, output: 200 },
    ],
  });

  const chart = tokensChart(session.tokens!);
  const bars = parts(chart, 'data-bar');
  assert.deepEqual(
    bars.map((bar) => ['data-read', 'data-write', 'data-uncached'].map((name) => Number(attr(bar, name)))),
    [
      [0, 40_000, 10_000],
      [40_000, 10_000, 0],
      [50_000, 0, 0],
    ],
  );
  for (const bar of bars) assert.deepEqual(parts(bar, 'class').map((rect) => attr(rect, 'class')), ['k-read', 'k-write', 'k-uncached']);
  assert.deepEqual(numbers(bars, 'data-output'), [300, 500, 200]);
  assert.equal(parts(chart, 'data-output').filter((element) => element.startsWith('<polyline')).length, 1);
  assert.match(text(chart), /cache hit 60%/);
});

// Five omp model calls at 10:00 to 10:04, which read `reads[i]` tokens from the prompt cache and
// wrote `writes[i]`, at the cost `writeCosts[i]` of that write.
const fiveOmpCalls = (reads: number[], writes: number[], writeCosts: number[]): OmpCall[] =>
  reads.map((read, i) => ({ at: at(`10:0${i}`), read, write: writes[i], uncached: 100, output: 10, cost: writeCosts[i] + 0.01, writeCost: writeCosts[i] }));

test('Cold start of an omp session', async () => {
  const session = await ompView({ calls: fiveOmpCalls([0, 1000, 1000, 0, 1000], [1000, 0, 0, 600_000, 0], [0.01, 0, 0, 2.25, 0]) });

  const [note] = parts(tokensChart(session.tokens!), 'data-part', 'cold-note');
  assert.equal(text(note), '1 cold start · 600k written again · $2.25');
  // its numbers are figures, in the figures' font
  assert.equal(textOutsideFigures(note), 'cold start · written again ·');
});

test('Session without a cold start', async () => {
  const session = await ompView({ calls: fiveOmpCalls([0, 1000, 1000, 1000, 1000], [1000, 0, 0, 0, 0], [0.01, 0, 0, 0, 0]) });

  const chart = tokensChart(session.tokens!);
  assert.equal(parts(chart, 'data-bar').length, 5);
  assert.equal(parts(chart, 'data-part', 'cold-note').length, 0);
});

test('Cold starts of a Claude Code session', async () => {
  const reads = [1000, 1000, 0, 1000, 0];
  const writes = [0, 0, 200_000, 0, 300_000];
  const session = await claudeView(reads.map((read, i) => ({ at: at(`10:0${i}`), read, write: writes[i], uncached: 100, output: 10 })));

  const [note] = parts(tokensChart(session.tokens!), 'data-part', 'cold-note');
  assert.equal(text(note), '2 cold starts · 500k written again · n/a');
});

test('Tokens of grouped calls add up', async () => {
  const calls = Array.from({ length: 400 }, (_, i) => ({ at: at('10:00') + i * 1000, read: 1000, output: 10 }));
  const session = await ompView({ calls });

  const bars = parts(tokensChart(session.tokens!, 100), 'data-bar');
  assert.equal(bars.length, 100);
  assert.deepEqual(new Set(numbers(bars, 'data-read')), new Set([4000]));
  assert.deepEqual(new Set(numbers(bars, 'data-output')), new Set([40]));
  assert.equal(
    numbers(bars, 'data-read').reduce((sum, read) => sum + read, 0),
    400_000,
  );
});

test('Context of grouped calls is their last value', async () => {
  const contexts = [100_000, 200_000, 300_000, 400_000];
  const session = await ompView({ calls: contexts.map((context, i) => ({ at: at(`10:0${i}`), uncached: context, output: 10, context })) });

  const [svg] = parts(contextChart(session.context!, 2), 'data-chart', 'context');
  assert.deepEqual(numbers(points(svg), 'data-v'), [0.2, 0.4]);
});

test('Cost of grouped calls adds up', async () => {
  const costs = [0.1, 0.2, 0.3, 0.4];
  const session = await ompView({ calls: costs.map((cost, i) => ({ at: at(`10:0${i}`), uncached: 1000, output: 10, cost })) });

  const chart = costChart(session.cost!, 2);
  const [own] = parts(chart, 'data-layer', 'own');
  assert.deepEqual(numbers(points(own), 'data-v'), [0.3, 1]);
  // the total and where it comes from are the session screen's cost card's, not the chart's
  assert.equal(figure(chart, 'cost'), undefined);
  assert.doesNotMatch(text(chart), /logs it/);
});

test('a session without a model call draws no chart', async () => {
  const session: SessionView = await ompView({ calls: [] });

  assert.equal(contextChart(session.context!), '');
  assert.equal(tokensChart(session.tokens!), '');
  assert.equal(costChart(session.cost!), '');
});
