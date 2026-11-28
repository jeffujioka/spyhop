// The costs end to end: the real worker, the controller (src/live/controller.ts) and its screens,
// through the frame the tests play (`openLive`, test/helpers/live.ts), over an omp session with a
// Copilot call priced from the Copilot price table (test/helpers/prices.ts), a call through
// `anthropic` and a `recap` side call, and a Claude Code session with a `cost-state` on each of
// two days, both under a temporary home read by the real programs; from the fleet card to the
// session screen's cost card, then the Spend tab's Week, from the history store the worker's
// catch-up filled (test/helpers/history.ts). Time is node:test's mock clock.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { caughtUp } from '../helpers/history.ts';
import { claudeSession, FIX, folderOf, ompSession, type OmpCall, open, openOnFleet } from '../helpers/live.ts';
import { attr, figure, parts, text } from '../helpers/markup.ts';
import { withCopilotPrices } from '../helpers/prices.ts';

// The clock of this test: 2026-11-28 15:00 UTC.
const CLOCK = Date.parse('2026-11-28T15:00:00.000Z');

// Epoch ms of `hhmm` UTC on `day` (YYYY-MM-DD).
const on = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00.000Z`);

// The rows of the Spend tab's list `list` (`repo`, `model` or `harness`) in `html`, each as the
// text it shows.
const listOf = (html: string, list: string) => parts(parts(html, 'data-list', list)[0], 'class', 'row item').map(text);

test('costs end to end', async () => {
  withCopilotPrices({ 'claude-opus-5.5': { input: 500, cachedInput: 50, cacheWrite: 625, output: 2500, tiers: [] } });
  // the Copilot call the table prices at 0.25 USD (omp logged 0.90), the call through `anthropic`
  // that logged 0.40 USD and the `recap` side call that logged 0.02 USD, all on 28 November
  const calls: OmpCall[] = [
    { at: on('2026-11-28', '10:00'), provider: 'github-copilot', model: 'claude-opus-5.5', uncached: 10_000, read: 100_000, write: 16_000, output: 2_000, cost: 0.9 },
    { at: on('2026-11-28', '11:00'), provider: 'anthropic', model: 'claude-opus-5.5', uncached: 1_000, output: 100, cost: 0.4 },
    { at: on('2026-11-28', '11:30'), provider: 'anthropic', model: 'claude-haiku-5.5', side: 'recap', output: 100, cost: 0.02 },
  ];
  let home = '';
  const opened = await openOnFleet([FIX], {
    now: CLOCK,
    prepare: (at) => {
      home = at;
      ompSession(home, folderOf(home, FIX), { title: 'Fix the login bug', calls });
      // a Claude Code session whose `cost-state` of 27 November gives 1.00 USD and of 28 November
      // 1.80 USD, each dated by the model call before it
      claudeSession(home, join(home, 'web'), {
        model: 'claude-opus-5-5',
        calls: [{ at: on('2026-11-27', '12:00'), output: 1_000 }, { at: on('2026-11-28', '12:00'), output: 1_000 }],
        costStates: [
          { at: on('2026-11-27', '12:00') + 1, models: { 'claude-opus-5-5': 1 } },
          { at: on('2026-11-28', '12:00') + 1, models: { 'claude-opus-5-5': 1.5, 'claude-sonnet-5': 0.3 } },
        ],
      });
    },
  });

  // the fleet card: the Copilot call at GitHub prices, the call through `anthropic` and the side call
  const [card] = parts(opened.html(), 'data-part', 'card');
  assert.equal(figure(card, 'cost'), '$0.67');

  // the session screen's cost card: the part from GitHub prices and the part omp logged
  await open(opened, 'Fix the login bug');
  const [costCard] = parts(opened.html(), 'class', 'cost-card');
  assert.equal(figure(costCard, 'total'), '$0.67');
  assert.match(text(costCard), /\$0\.25 from tokens at GitHub prices/);
  assert.match(text(costCard), /\$0\.42 as omp logged it/);

  // the Spend tab's Week, once the catch-up has read both sessions
  opened.live.press('back');
  await caughtUp(home);
  await opened.openTab('spend', 'week');
  const html = opened.html();
  assert.deepEqual(listOf(html, 'harness'), ['Claude Code $1.80', 'omp $0.67']);
  assert.deepEqual(listOf(html, 'model'), [
    'claude-opus-5-5 $1.50',
    'anthropic/claude-opus-5.5 $0.40',
    'claude-sonnet-5 $0.30',
    'github-copilot/claude-opus-5.5 $0.25',
    'anthropic/claude-haiku-5.5 $0.02',
  ]);
  assert.equal(figure(html, 'sideCost'), '$0.02');
  // Claude Code's two days: 1.00 USD on 27 November, and on 28 November its 0.80 USD and omp's 0.67
  const [chart] = parts(html, 'data-chart', 'range-cost');
  const days = Object.fromEntries(parts(chart, 'data-key').map((point) => [attr(point, 'data-key'), Number(Number(attr(point, 'data-v')).toFixed(2))]));
  assert.equal(days['2026-11-27'], 1);
  assert.equal(days['2026-11-28'], 1.47);
  assert.equal(figure(html, 'cost'), '$2.47');
});
