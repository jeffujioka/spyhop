// The costs end to end: the real worker, the controller (src/live/controller.ts) and its screens,
// through the frame the tests play (`openLive`, test/helpers/live.ts), over an omp session with a
// Copilot call priced from the Copilot price table (test/helpers/prices.ts), a call through
// `anthropic` and a `recap` side call, and a Claude Code session with a `cost-state` on each of
// two days, both under a temporary home read by the real programs; from the fleet card to the
// session screen's cost card, then the Spend tab's Week, from the history store the worker's
// catch-up filled (test/helpers/history.ts). Time is node:test's mock clock.
// Then every Orca host end to end: this computer, the SSH host `devbox`, which has `zstd`, and
// `oldbox`, which cannot be reached, stood in for by `orca` and `ssh` (test/helpers/stand-ins.ts),
// through the Spend tab's Month.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { RANGE_REFRESH_MS } from '../../src/core/refresh.js';
import { opencodeSession } from '../helpers/agent-cards.ts';
import { tempHome } from '../helpers/files.ts';
import { caughtUp } from '../helpers/history.ts';
import { claudeSession, FIX, folderOf, ompSession, type OmpCall, open, openLive, openOnFleet, until } from '../helpers/live.ts';
import { attr, figure, listOf, parts, text } from '../helpers/markup.ts';
import { DEVBOX_HOST, environmentListOf, hostListOf, LOCAL_HOST } from '../helpers/orca-answers.ts';
import { withCopilotPrices } from '../helpers/prices.ts';
import { readOnlyLine } from '../helpers/read-only.ts';

// The clock of this test: 2026-11-28 15:00 UTC.
const CLOCK = Date.parse('2026-11-28T15:00:00.000Z');

// Epoch ms of `hhmm` UTC on `day` (YYYY-MM-DD).
const on = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00.000Z`);

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
      // a Claude Code session whose `cost-state` of 27 November gives 1.00 USD in all and of 28
      // November 1.80 USD in all, over two models, each dated by the model call before it
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

test('every Orca host end to end', async () => {
  const devboxHome = tempHome();
  const oldbox = { kind: 'ssh', name: 'oldbox', id: 'oldbox', selector: '--host ssh:oldbox', connected: true };
  // devbox's omp session: a call of 2.00 USD on 27 November, then, later, one of 0.10 USD
  const devboxOmp = (calls: OmpCall[]) => ompSession(devboxHome, join(devboxHome, 'api'), { title: 'api', calls });
  const first: OmpCall = { at: on('2026-11-27', '09:00'), output: 100, cost: 2 };
  let home = '';
  const opened = await openLive([], {
    now: CLOCK,
    homes: { devbox: devboxHome },
    orca: { 'host list --json': hostListOf(LOCAL_HOST, DEVBOX_HOST, oldbox), 'environment list --json': environmentListOf() },
    prepare: (at) => {
      home = at;
      // this computer: an omp session of 1.00 USD and a Claude Code session of 0.50 USD
      ompSession(home, join(home, 'api'), { title: 'api', calls: [{ at: on('2026-11-26', '10:00'), output: 100, cost: 1 }] });
      claudeSession(home, join(home, 'web'), {
        model: 'claude-opus-5-5',
        calls: [{ at: on('2026-11-26', '12:00'), output: 1_000 }],
        costStates: [{ at: on('2026-11-26', '12:00') + 1, models: { 'claude-opus-5-5': 0.5 } }],
      });
      // devbox: the omp session, and an opencode database with a call of 0.30 USD
      devboxOmp([first]);
      opencodeSession(devboxHome, join(devboxHome, 'web'), {
        provider: 'anthropic',
        model: 'claude-opus-5.5',
        calls: [{ uncached: 100, read: 0, write: 0, output: 50 }],
        cost: 0.3,
        callCost: 0.3,
        last: on('2026-11-27', '14:00'),
      });
    },
  });
  await caughtUp(home);

  await opened.openTab('spend', 'month');

  const html = opened.html();
  assert.deepEqual(listOf(html, 'harness'), ['omp $3.00', 'Claude Code $0.50', 'opencode $0.30']);
  assert.equal(figure(html, 'cost'), '$3.80');
  assert.match(text(parts(html, 'data-part', 'not-read')[0] ?? ''), /Not read this time: oldbox\./);
  const lines = opened.calls.ssh();
  assert.ok(lines.some(([alias]) => alias === 'devbox') && lines.some(([alias]) => alias === 'oldbox'), JSON.stringify(lines));
  assert.deepEqual(lines.filter((args) => !readOnlyLine(args.at(-1)!)), []);

  // a call of 0.10 USD on devbox, then the panel's next ask of the tab a minute later
  devboxOmp([first, { at: CLOCK, output: 100, cost: 0.1 }]);
  mock.timers.tick(RANGE_REFRESH_MS);

  await until(() => figure(opened.html(), 'cost') === '$3.90');
  assert.deepEqual(opened.calls.ssh().filter((args) => !readOnlyLine(args.at(-1)!)), []);
});
