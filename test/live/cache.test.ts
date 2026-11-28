// The Cache tab: the hit rate over a range and over time, the cold starts by miss cause with their
// cost, the returns by time away, the compactions by kind and a hint per cause: the real worker's
// answer from the history store, which its first catch-up filled from omp, Claude Code and opencode
// session files under a temporary home (test/helpers/history.ts), drawn and read through the
// markup's conventions (test/helpers/markup.ts).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { rangeOf } from '../helpers/history.ts';
import { opencodeSession } from '../helpers/agent-cards.ts';
import { claudeSession, type Compaction, type OmpCall, ompCompactsAt, ompSession, ompWindow } from '../helpers/live.ts';
import { attr, figure, parts, text } from '../helpers/markup.ts';
import { withCopilotPrices } from '../helpers/prices.ts';

// The clock of these tests: 2026-11-28 15:00 UTC.
const CLOCK = Date.parse('2026-11-28T15:00:00.000Z');

// Epoch ms of `time` (HH:MM, or HH:MM:SS) on `day` (2026-11-27 unless given), UTC.
const at = (time: string, day = '2026-11-27') => Date.parse(`${day}T${time.length === 5 ? `${time}:00` : time}.000Z`);

// A model call of 1,000 tokens written to the prompt cache at `time`, which read none.
const cold = (time: string, more: Partial<OmpCall> = {}): OmpCall => ({ at: at(time), read: 0, write: 1000, uncached: 10, output: 5, cost: 0.1, writeCost: 0.05, ...more });

// The tab of an omp session of the folder `api` that logs `calls` and `compactions`.
const cacheOf = (calls: OmpCall[], compactions: Compaction[] = [], prepare?: (home: string) => void) =>
  rangeOf([], {
    tab: 'cache',
    range: 'week',
    now: CLOCK,
    prepare: (home) => {
      prepare?.(home);
      ompSession(home, join(home, 'api'), { title: 'api', calls, compactions });
    },
  }).then(({ html }) => html);

test('Hit rate by day', async () => {
  const html = await cacheOf([
    { at: at('10:00'), read: 400_000, write: 30_000, uncached: 20_000, output: 5, cost: 0.1 },
    { at: at('11:00'), read: 500_000, write: 30_000, uncached: 20_000, output: 5, cost: 0.1 },
    { at: at('10:00', '2026-11-28'), read: 100_000, write: 100_000, uncached: 0, output: 5, cost: 0.1 },
  ]);

  const [chart] = parts(html, 'data-chart', 'range-hitRate');
  const points = parts(chart, 'data-key').map((point) => [attr(point, 'data-key'), attr(point, 'data-v')]);
  assert.deepEqual(points.slice(-2), [
    ['2026-11-27', '0.9'],
    ['2026-11-28', '0.5'],
  ]);
  assert.deepEqual(points.slice(0, 5).map(([, v]) => v), Array(5).fill('n/a'));
  const over = text(parts(html, 'data-name', 'Cache hit rate over time')[0]);
  assert.match(over, /90%/);
  assert.match(over, /50%/);
  assert.equal(figure(html, 'hitRate'), '83%');
});

test('omp and Claude Code cold starts', async () => {
  const html = await cacheOf(
    [cold('10:00', { cttl: '5m' }), cold('10:20', { cttl: '5m', write: 200_000, writeCost: 0.5 }), cold('10:40', { cttl: '5m', write: 100_000, writeCost: 0.3 })],
    [],
    (home) =>
      claudeSession(home, join(home, 'cc'), {
        calls: [
          { at: at('10:00'), uncached: 10, output: 5 },
          { at: at('10:10'), uncached: 10, write: 50_000, output: 5 },
        ],
      }),
  );

  assert.equal(figure(html, 'cold-expired'), '2 · 300,000 · $0.80');
  assert.equal(figure(html, 'cold-other'), '1 · 50,000');
  const [note] = parts(html, 'data-part', 'left-out');
  assert.match(text(note), /Claude Code/);
  assert.doesNotMatch(text(note), /omp/);
});

test('Copilot cold start', async () => {
  withCopilotPrices({ 'claude-opus-5.5': { input: 500, cachedInput: 50, cacheWrite: 625, output: 2500, tiers: [] } });
  const copilot = { provider: 'github-copilot', model: 'claude-opus-5.5' };
  const html = await cacheOf([cold('10:00', copilot), cold('10:01', { ...copilot, write: 160_000, writeCost: undefined })]);

  assert.equal(figure(html, 'cold-other'), '1 · 160,000 · $1.00');
});

test('a Copilot cold start the price table cannot price has a cost n/a', async () => {
  withCopilotPrices({});
  const copilot = { provider: 'github-copilot', model: 'claude-opus-5.5' };
  const html = await cacheOf([
    cold('10:00', { ...copilot, cttl: '5m' }),
    cold('10:20', { ...copilot, cttl: '5m', write: 160_000, writeCost: undefined }),
  ]);

  assert.equal(figure(html, 'cold-expired'), '1 · 160,000 · n/a');
  const [hint] = parts(html, 'data-part', 'hint');
  assert.equal(text(hint), '1 cold start after the cache expired');
  assert.equal(parts(hint, 'data-estimate').length, 0);
  assert.equal(parts(html, 'data-part', 'left-out').length, 0);
});

test('a hint of cold starts without a cost names no saving', async () => {
  const { html } = await rangeOf([], {
    tab: 'cache',
    range: 'week',
    now: CLOCK,
    prepare: (home) =>
      claudeSession(home, join(home, 'cc'), {
        calls: [
          { at: at('10:00'), uncached: 10, write: 1000, output: 5, cache: '5m' },
          { at: at('10:20'), uncached: 10, write: 2000, output: 5 },
        ],
      }),
  });

  assert.equal(figure(html, 'cold-expired'), '1 · 2,000');
  assert.equal(text(parts(html, 'data-part', 'hint')[0]), '1 cold start after the cache expired');
});

test('Year charts the hit rate by month', async () => {
  const { html } = await rangeOf([], {
    tab: 'cache',
    range: 'year',
    now: CLOCK,
    prepare: (home) => ompSession(home, join(home, 'api'), { title: 'api', calls: [{ at: at('10:00'), read: 900, write: 100, uncached: 0, output: 5, cost: 0.1 }] }),
  });

  const points = parts(parts(html, 'data-chart', 'range-hitRate')[0], 'data-key').map((point) => [attr(point, 'data-key'), attr(point, 'data-v')]);
  assert.equal(points.length, 12);
  assert.deepEqual(points.at(-1), ['2026-11', '0.9']);
  assert.deepEqual(points.at(0), ['2025-12', 'n/a']);
});

test('Returns by time away', async () => {
  const html = await cacheOf([
    cold('10:00', { stop: 'stop' }),
    cold('10:02', { prompted: at('10:01:59'), read: 900, stop: 'stop' }),
    cold('10:22', { prompted: at('10:21:59'), stop: 'stop' }),
    cold('11:02', { prompted: at('11:01:59'), read: 900, stop: 'stop' }),
    cold('14:02', { prompted: at('14:01:59'), stop: 'stop' }),
  ]);

  assert.equal(figure(html, 'away-under5'), '1 return · 0 cold');
  assert.equal(figure(html, 'away-to60'), '2 returns · 1 cold');
  assert.equal(figure(html, 'away-over60'), '1 return · 1 cold');
});

const compactionsOf = (html: string) => text(parts(html, 'data-name', 'Compactions')[0]);

test('Claude Code and opencode compactions', async () => {
  const html = await cacheOf([cold('10:00')], [], (home) => {
    claudeSession(home, join(home, 'cc'), {
      calls: [
        { at: at('10:00'), uncached: 10, output: 5 },
        { at: at('10:10'), uncached: 10, output: 5 },
      ],
      compactions: [
        { at: at('10:01'), trigger: 'auto', before: 150_000, after: 10_000 },
        { at: at('10:05'), trigger: 'manual', before: 150_000, after: 10_000 },
      ],
    });
    opencodeSession(home, join(home, 'web'), {
      provider: 'anthropic',
      model: 'claude-opus-5.5',
      cost: 0.2,
      calls: [{ uncached: 10, read: 0, write: 1000, output: 5, at: at('10:00') }],
      compactions: [{ at: at('10:30'), reason: 'manual' }],
    });
  });

  assert.equal(figure(html, 'compactions'), '1 context full · 2 manual');
  assert.doesNotMatch(compactionsOf(html), /inferred/);
  // a small figure in a row, as the other lists draw theirs, not the big number of a figure block
  assert.match(parts(html, 'data-name', 'Compactions')[0], /<div class="row item"><span class="num" data-figure="compactions">/);
});

test('omp compactions inferred', async () => {
  const html = await cacheOf(
    [cold('10:00'), cold('10:18', { read: 100 }), cold('10:30:30', { read: 100 })],
    [
      { at: at('10:00:30'), before: 820_000, after: 20_000 },
      { at: at('10:30'), before: 300_000, after: 20_000 },
      { at: at('10:31'), before: 300_000, after: 20_000 },
    ],
    (home) => {
      ompWindow(home, 1_000_000);
      ompCompactsAt(home, 800_000);
    },
  );

  assert.equal(figure(html, 'compactions'), '1 context full · 1 idle · 1 manual');
  assert.match(compactionsOf(html), /inferred/);
});

test('Hint for an expired cache', async () => {
  const html = await cacheOf(
    [cold('10:00', { cttl: '5m' }), cold('10:20', { cttl: '5m', writeCost: 0.4 }), cold('10:40', { cttl: '5m', writeCost: 0.4 }), cold('11:00', { cttl: '5m', writeCost: 0.4 })],
    [],
    (home) => ompSession(home, join(home, 'b'), { title: 'b', calls: [cold('10:00'), cold('10:01'), cold('10:02')] }),
  );

  const hints = parts(html, 'data-part', 'hint');
  assert.equal(hints.length, 1);
  assert.equal(text(hints[0]), '3 cold starts after the cache expired: avoiding them would have saved up to $1.20 estimate');
  assert.equal(parts(hints[0], 'data-estimate').length, 1);
  assert.equal(figure(html, 'cold-other'), '2 · 2,000 · $0.10');
  assert.equal(attr(hints[0], 'data-cause'), 'expired');
});

test('Titles of the Cache tab', async () => {
  const html = await cacheOf(
    [cold('10:00', { cttl: '5m', stop: 'stop' }), cold('10:20', { cttl: '5m', prompted: at('10:19:59'), stop: 'stop' }), cold('10:40', { cttl: '5m' })],
    [{ at: at('10:30'), before: 300_000, after: 20_000 }],
  );

  const figures = parts(html, 'data-part', 'figure');
  assert.ok(figures.length >= 6, String(figures.length));
  for (const titled of figures) {
    assert.notEqual(text(parts(titled, 'data-title')[0] ?? ''), '', titled);
    assert.notEqual(text(parts(titled, 'data-meaning')[0] ?? ''), '', titled);
  }
  assert.equal(parts(html, 'data-chart', 'range-hitRate').length, 1);
  const hint = parts(html, 'data-part', 'hint')[0];
  assert.equal(parts(hint, 'data-estimate').length, 1);
});
