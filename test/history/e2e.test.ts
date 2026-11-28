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
// Then the Cache tab end to end: omp and Claude Code on this computer and opencode on `devbox`, each
// with its cold starts, returns and compactions, through the Cache tab's Week and back from Spend.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { RANGE_REFRESH_MS } from '../../src/core/refresh.js';
import { opencodeSession, workspace } from '../helpers/agent-cards.ts';
import { tempHome } from '../helpers/files.ts';
import { caughtUp } from '../helpers/history.ts';
import { claudeSession, FIX, folderOf, ompCompactsAt, ompSession, ompSubAgent, ompWindow, type OmpCall, open, openLive, openOnFleet, until } from '../helpers/live.ts';
import { attr, figure, listOf, parts, text } from '../helpers/markup.ts';
import { DEVBOX, DEVBOX_HOST, DEVBOX_LISTS, environmentListOf, hostListOf, LOCAL_HOST } from '../helpers/orca-answers.ts';
import type { HostWorkspace } from '../helpers/orca-host.ts';
import { withCopilotPrices } from '../helpers/prices.ts';
import { readOnlyLine, ZSTD_PIPE } from '../helpers/read-only.ts';

// The clock of this test: 2026-11-28 15:00 UTC.
const CLOCK = Date.parse('2026-11-28T15:00:00.000Z');

// Epoch ms of `hhmm` UTC on `day` (YYYY-MM-DD).
const on = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00.000Z`);

// Epoch ms of `hh:mm:ss` UTC on 25 November, the day of the Trace test.
const at = (hms: string) => Date.parse(`2026-11-25T${hms}.000Z`);

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
  assert.doesNotThrow(() => execFileSync('zstd', ['-V'], { stdio: 'ignore' }), 'this Mac has no zstd');
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
  const [notRead, ...more] = parts(html, 'data-part', 'not-read');
  assert.ok(notRead !== undefined && more.length === 0, html);
  assert.match(text(notRead), /Not read this time: oldbox\./);
  const lines = opened.calls.ssh();
  assert.ok(lines.some(([alias]) => alias === 'devbox') && lines.some(([alias]) => alias === 'oldbox'), JSON.stringify(lines));
  assert.deepEqual(lines.filter((args) => !readOnlyLine(args.at(-1)!)), []);
  // devbox's session file and opencode's rows come through `zstd`
  const devbox = lines.filter(([alias]) => alias === 'devbox').map((args) => args.at(-1)!);
  const compressed = (program: string, word: string) => devbox.some((line) => line.startsWith(`${ZSTD_PIPE} '${program}'`) && line.includes(word));
  assert.ok(compressed('dd', '.jsonl') && compressed('sqlite3', "'WITH RECURSIVE "), JSON.stringify(devbox));

  // a call of 0.10 USD on devbox, then the panel's next ask of the tab a minute later
  devboxOmp([first, { at: CLOCK, output: 100, cost: 0.1 }]);
  mock.timers.tick(RANGE_REFRESH_MS);

  await until(() => figure(opened.html(), 'cost') === '$3.90');
  assert.deepEqual(opened.calls.ssh().filter((args) => !readOnlyLine(args.at(-1)!)), []);
});

test("a session's Trace end to end", async () => {
  assert.doesNotThrow(() => execFileSync('zstd', ['-V'], { stdio: 'ignore' }), 'this Mac has no zstd');
  const devboxHome = tempHome();
  const infra: HostWorkspace = { project: 'infra', name: 'main', agents: ['working'], hostId: `ssh:${DEVBOX}`, sessionId: 's1', title: 'π - Deploy it' };
  let home = '';
  const opened = await openLive([infra], {
    now: CLOCK,
    homes: { devbox: devboxHome },
    orca: DEVBOX_LISTS,
    prepare: (made) => {
      home = made;
      // devbox's omp session `Deploy it` with the sub-agent `Impl1`, which started `Rev1`
      const folder = workspace(made, 'infra-main');
      const main = ompSession(devboxHome, folder, {
        title: 'Deploy it',
        calls: [
          { prompted: at('10:00:00'), started: at('10:00:00'), at: at('10:00:05'), output: 10, cost: 1, stop: 'toolUse', tools: [{ name: 'read', started: at('10:00:05'), answered: at('10:00:20') }] },
          { started: at('10:00:20'), at: at('10:00:30'), output: 10, stop: 'stop' },
        ],
        results: [{ at: at('10:09:00'), jobs: [{ jobId: 'Impl1', status: 'completed' }] }],
      });
      const impl = ompSubAgent(devboxHome, folder, 'Impl1', {
        calls: [{ at: at('10:08:00'), output: 10, cost: 0.5 }],
        init: { at: at('10:01:00'), kind: 'task' },
        parent: main,
        results: [{ at: at('10:07:00'), jobs: [{ jobId: 'Rev1', status: 'failed' }] }],
      });
      ompSubAgent(devboxHome, folder, 'Impl1/Rev1', { calls: [{ at: at('10:06:00'), output: 10, cost: 0.25 }], init: { at: at('10:02:00'), kind: 'reviewer' }, parent: impl });
      // this computer: a past Claude Code session of 0.50 USD
      claudeSession(made, join(made, 'web'), {
        model: 'claude-opus-5-5',
        title: 'Past Claude job',
        calls: [{ prompted: at('09:00:00'), at: at('09:00:10'), output: 1_000, stop: 'end_turn' }],
        costStates: [{ at: at('09:00:10') + 1, models: { 'claude-opus-5-5': 0.5 } }],
      });
    },
  });
  await until(() => opened.html().includes('data-part="counts"'));
  await caughtUp(home);
  const loaded = () => parts(opened.html(), 'data-part', 'loading').length === 0;

  // the only Live card is the omp session's: the past Claude Code session has none
  const cards = parts(opened.html(), 'data-part', 'card');
  assert.equal(cards.length, 1);
  assert.equal(text(parts(cards[0], 'class', 'title grow')[0]), 'Deploy it');
  // the shown session's Trace: four lanes and both sub-agent rows
  opened.live.press(attr(cards[0], 'data-press')!);
  await until(loaded);
  opened.live.press('view:trace');
  await until(() => parts(opened.html(), 'data-lane').length === 4);
  const rows = parts(opened.html(), 'data-agent').map((row) => ({ text: text(parts(row, 'class', 'row label')[0]), depth: Number(attr(row, 'data-depth')) }));
  assert.deepEqual(rows, [
    { text: 'Impl1 · completed · $0.50', depth: 1 },
    { text: 'Rev1 · failed · $0.25', depth: 2 },
  ]);

  // the Spend tab lists both sessions
  opened.live.press('back');
  await opened.openTab('spend', 'month');
  const costly = parts(parts(opened.html(), 'data-list', 'costliest')[0] ?? '', 'data-part', 'costly');
  const titleOf = (row: string) => text(parts(row, 'class', 'title grow')[0]);
  assert.deepEqual(costly.map(titleOf).sort(), ['Deploy it', 'Past Claude job']);

  // the past one: its summary and Trace, and back to the Spend tab
  const past = costly.find((row) => titleOf(row) === 'Past Claude job')!;
  opened.live.press(attr(past, 'data-press')!);
  await until(() => attr(opened.html(), 'data-screen') === 'past' && loaded());
  assert.equal(text(parts(opened.html(), 'class', 'title grow')[0]), 'Past Claude job');
  assert.deepEqual(
    ['repo', 'harness', 'models', 'cost', 'tokens', 'duration'].map((name) => figure(opened.html(), name)),
    [join(home, 'web'), 'Claude Code', 'claude-opus-5-5', '$0.50', '1k', '10s'],
  );
  assert.equal(parts(opened.html(), 'data-lane').length, 4);
  assert.equal(parts(opened.html(), 'data-part', 'switch').length, 0);
  opened.live.press('back');
  await until(() => attr(opened.html(), 'data-screen') === 'range' && loaded());
  assert.equal(attr(opened.html(), 'data-tab'), 'spend');
  assert.equal(attr(parts(opened.html(), 'data-press', 'range:month')[0], 'aria-pressed'), 'true');
  const devbox = opened.calls.ssh().filter(([alias]) => alias === 'devbox');
  assert.ok(devbox.some((args) => args.at(-1)!.startsWith(`${ZSTD_PIPE} 'dd'`)), JSON.stringify(devbox));
  assert.deepEqual(opened.calls.ssh().filter((args) => !readOnlyLine(args.at(-1)!)), []);
});

test('the Cache tab end to end', async () => {
  assert.doesNotThrow(() => execFileSync('zstd', ['-V'], { stdio: 'ignore' }), 'this Mac has no zstd');
  const devboxHome = tempHome();
  const day = (time: string) => on('2026-11-27', time.slice(0, 5)) + (time.length > 5 ? Number(time.slice(6)) * 1000 : 0);
  // a model call of 1,000 tokens written to the prompt cache, which read none, ended by `stop`
  const cold = (time: string, more: Partial<OmpCall> = {}): OmpCall => ({ at: day(time), read: 0, write: 1000, uncached: 10, output: 5, cost: 0.1, writeCost: 0.05, stop: 'stop', thinking: 'high', ...more });
  const write = { uncached: 10, read: 0, write: 1000, output: 5 };
  let home = '';
  const opened = await openLive([], {
    now: CLOCK,
    homes: { devbox: devboxHome },
    orca: { 'host list --json': hostListOf(LOCAL_HOST, DEVBOX_HOST), 'environment list --json': environmentListOf() },
    prepare: (made) => {
      home = made;
      // this computer, omp: an expired cache, a compaction (inferred from the context's size), a model
      // switch, a thinking-level switch, a warm call and a return after 3 hours
      ompWindow(home, 1_000_000);
      ompCompactsAt(home, 800_000);
      ompSession(home, join(home, 'api'), {
        title: 'api',
        calls: [
          cold('10:00', { cttl: '5m' }),
          cold('10:20', { cttl: '5m', prompted: day('10:19:59') }),
          cold('10:21', { prompted: day('10:20:59') }),
          cold('10:22', { model: 'model-b' }),
          cold('10:23', { model: 'model-b', thinking: 'low' }),
          cold('10:24', { model: 'model-b', thinking: 'low', read: 900, write: 100, uncached: 0 }),
          cold('14:00', { model: 'model-b', thinking: 'low', prompted: day('13:59:59') }),
        ],
        compactions: [{ at: day('10:20:30'), before: 820_000, after: 20_000 }],
      });
      // this computer, Claude Code: a compaction and a cold start after it, which logs no cost
      claudeSession(home, join(home, 'cc'), {
        calls: [
          { at: day('10:00'), uncached: 10, output: 5 },
          { at: day('10:10'), uncached: 10, write: 50_000, output: 5 },
        ],
        compactions: [{ at: day('10:05'), trigger: 'auto', before: 150_000, after: 10_000 }],
      });
      // devbox, opencode: a return after 2 hours, a model switch, a variant switch and a compaction
      // of each reason with a cold start after it
      opencodeSession(devboxHome, join(devboxHome, 'web'), {
        provider: 'anthropic',
        model: 'claude-opus-5.5',
        cost: 0.7,
        calls: [
          { ...write, at: day('09:00') },
          { ...write, at: day('11:00') },
          { ...write, at: day('11:01'), model: 'claude-sonnet-5' },
          { ...write, at: day('11:02'), model: 'claude-sonnet-5', variant: 'low' },
          { ...write, at: day('11:04'), model: 'claude-sonnet-5', variant: 'low' },
          { ...write, at: day('11:07'), model: 'claude-sonnet-5', variant: 'low' },
        ],
        compactions: [{ at: day('11:03:30'), reason: 'manual' }, { at: day('11:06:30'), reason: 'auto' }],
      });
    },
  });
  await caughtUp(home);

  await opened.openTab('cache', 'week');
  const pressed = () => parts(opened.html(), 'data-press').filter((button) => attr(button, 'aria-pressed') === 'true').map((button) => attr(button, 'data-press')).filter((press) => press!.startsWith('range:'));
  assert.deepEqual(pressed(), ['range:week']);
  const drawn = () => {
    const html = opened.html();
    // the hit rate chart, which has the day's calls
    const [chart] = parts(html, 'data-chart', 'range-hitRate');
    assert.ok(chart !== undefined && parts(chart, 'data-key').some((point) => attr(point, 'data-key') === '2026-11-27' && attr(point, 'data-v') !== 'n/a'), html);
    // the five causes, with the cold starts of omp, Claude Code and opencode
    assert.equal(figure(html, 'cold-expired'), '1 · 1,000 · $0.05');
    assert.equal(figure(html, 'cold-model'), '2 · 2,000 · $0.05');
    assert.equal(figure(html, 'cold-thinking'), '2 · 2,000 · $0.05');
    assert.equal(figure(html, 'cold-compaction'), '4 · 53,000 · $0.05');
    assert.equal(figure(html, 'cold-other'), '2 · 2,000 · $0.05');
    assert.match(text(parts(html, 'data-part', 'left-out')[0]), /Claude Code/);
    // the three time-away bands: the return after 1 minute, after 20 minutes and after 3 hours
    assert.equal(figure(html, 'away-under5'), '1 return · 1 cold');
    assert.equal(figure(html, 'away-to60'), '1 return · 1 cold');
    assert.equal(figure(html, 'away-over60'), '1 return · 1 cold');
    // the compaction kinds: omp's inferred, Claude Code's and one of opencode's by reason `auto`, and one `manual`
    assert.equal(figure(html, 'compactions'), '3 context full · 1 manual');
    assert.equal(parts(html, 'data-part', 'inferred').length, 1);
    // a hint per cause but other
    const hints = parts(html, 'data-part', 'hint');
    assert.deepEqual(hints.map((hint) => attr(hint, 'data-cause')).sort(), ['compaction', 'expired', 'model', 'thinking']);
    const expired = hints.find((hint) => attr(hint, 'data-cause') === 'expired')!;
    assert.equal(text(expired), '1 cold start after the cache expired: avoiding them would have saved up to $0.05 estimate');
    assert.equal(parts(expired, 'data-estimate').length, 1);
  };
  drawn();

  // the range stays Week when the tab changes to Spend and back
  await opened.openTab('spend');
  assert.equal(attr(opened.html(), 'data-tab'), 'spend');
  assert.deepEqual(pressed(), ['range:week']);
  await opened.openTab('cache');
  assert.equal(attr(opened.html(), 'data-tab'), 'cache');
  assert.deepEqual(pressed(), ['range:week']);
  drawn();

  const lines = opened.calls.ssh();
  assert.ok(lines.some(([alias]) => alias === 'devbox'), JSON.stringify(lines));
  assert.deepEqual(lines.filter((args) => !readOnlyLine(args.at(-1)!)), []);
  // devbox's opencode rows were read through `sqlite3 -readonly`
  assert.ok(lines.some(([alias, ...rest]) => alias === 'devbox' && /sqlite3'? '?-readonly/.test(rest.at(-1)!)), JSON.stringify(lines));
});
