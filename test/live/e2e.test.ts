// The live panel end to end: the real worker, the controller (src/live/controller.ts) and its
// screens, through the frame the tests play (`openLive`, test/helpers/live.ts), over an omp
// session file under a temporary home read by the real programs; from the fleet to the session
// screen, through one refresh, and back; and an omp session on the SSH target `devbox` with its
// sub-agents, read over the stand-in `ssh` (test/helpers/stand-ins.ts). Time is node:test's mock
// clock.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { REFRESH_INTERVAL_MS } from '../../src/core/refresh.js';
import { NOW, workspace } from '../helpers/agent-cards.ts';
import { tempHome } from '../helpers/files.ts';
import { FIX, folderOf, ompSession, ompSubAgent, ompWindow, type OmpCall, open, openOnFleet, spent, toolCalls, until } from '../helpers/live.ts';
import { attr, figure, parts, text } from '../helpers/markup.ts';
import { DEVBOX, DEVBOX_LISTS } from '../helpers/orca-answers.ts';
import type { HostWorkspace } from '../helpers/orca-host.ts';
import { readOnlyLine } from '../helpers/read-only.ts';

test('fleet to a session screen and back', async () => {
  // five model calls a minute apart, the first of 0.10 USD and making 3 `bash` tool calls, the
  // others of 0.05 USD; compacted between the third and the fourth; the sixth costs 0.20 USD
  const call = (i: number, context: number, cost: number): OmpCall => ({ at: NOW - 10 * 60_000 + i * 60_000, uncached: context, output: 10, cost, context, tools: i === 0 ? toolCalls('bash', 3) : [] });
  const calls = [100_000, 300_000, 600_000, 200_000, 400_000].map((context, i) => call(i, context, i === 0 ? 0.1 : 0.05));
  const compactions = [{ at: NOW - 10 * 60_000 + 2.5 * 60_000, before: 650_000, after: 150_000 }];
  let home = '';
  const write = (logged: OmpCall[]) => ompSession(home, folderOf(home, FIX), { title: 'Fix the login bug', calls: logged, compactions });
  const opened = await openOnFleet([FIX], {
    prepare: (at) => {
      home = at;
      ompWindow(home, 1_000_000);
      write(calls);
    },
  });

  // the fleet card: its spark line of the five contexts, and the cost so far
  const cardOf = () => parts(opened.html(), 'data-part', 'card')[0];
  assert.equal(attr(parts(cardOf(), 'data-chart', 'spark')[0], 'data-points'), '5');
  assert.equal(figure(cardOf(), 'cost'), '$0.30');

  await open(opened, 'Fix the login bug');

  const html = opened.html();
  const [context] = parts(html, 'data-chart', 'context');
  assert.equal(parts(context, 'data-v').length, 5);
  assert.equal(parts(context, 'data-mark').length, 1);
  assert.equal(parts(parts(html, 'data-chart', 'tokens')[0], 'data-bar').length, 5);
  assert.match(text(parts(parts(html, 'data-part', 'tools')[0], 'class', 'row head')[0]), /^Tools 3 tool calls/);
  assert.equal(parts(parts(html, 'data-part', 'models')[0], 'class', 'row item').length, 1);
  assert.equal(parts(html, 'data-part', 'session').length, 1);

  // one more model call, then the refresh's 2 s
  write([...calls, call(5, 500_000, 0.2)]);
  mock.timers.tick(REFRESH_INTERVAL_MS);
  await until(() => parts(parts(opened.html(), 'data-chart', 'tokens')[0] ?? '', 'data-bar').length === 6);
  assert.equal(attr(opened.html(), 'data-screen'), 'session');

  opened.live.press('back');

  assert.equal(attr(opened.html(), 'data-screen'), 'fleet');
  await until(() => figure(cardOf(), 'cost') === '$0.50');
  assert.equal(attr(parts(cardOf(), 'data-chart', 'spark')[0], 'data-points'), '6');
});

test('a session with sub-agents end to end', async () => {
  const minute = 60_000;
  // the workspace `infra`/`main` on `devbox`, with one working omp agent on the session `s1`,
  // which Orca titles `π - Deploy the cluster`
  const deploy: HostWorkspace = { project: 'infra', name: 'main', agents: ['working'], hostId: `ssh:${DEVBOX}`, sessionId: 's1', title: 'π - Deploy the cluster' };
  const remote = tempHome();
  // the session's own 1.00 USD; `Impl1`, ended, at 0.50 USD, and `Rev1`, which `Impl1` started,
  // ended, at 0.25 USD; `Scout1`, running, at 0.20 USD, which later logs 0.10 USD more
  const scout = [spent(0.2, NOW - 4 * minute)];
  let path = '';
  const writeScout = (calls: OmpCall[]) =>
    ompSubAgent(remote, path, 'Scout1', { running: true, init: { at: NOW - 5 * minute, kind: 'scout', task: 'what a plugin panel can draw' }, calls });
  const opened = await openOnFleet([deploy], {
    homes: { devbox: remote },
    orca: DEVBOX_LISTS,
    prepare: (home) => {
      path = workspace(home, 'infra-main');
      ompSession(remote, path, { title: 'Deploy the cluster', calls: [spent(1, NOW - 30 * minute)] });
      ompSubAgent(remote, path, 'Impl1', { init: { at: NOW - 20 * minute, kind: 'implementer' }, calls: [spent(0.5, NOW - 18 * minute)] });
      ompSubAgent(remote, path, 'Impl1/Rev1', { init: { at: NOW - 15 * minute, kind: 'reviewer' }, calls: [spent(0.25, NOW - 12 * minute)] });
      writeScout(scout);
    },
  });

  // the fleet card, once every sub-agent transcript is read: its cost with all three, its chips
  const cardOf = () => parts(opened.html(), 'data-part', 'card')[0] ?? '';
  await until(() => figure(cardOf(), 'cost') === '$1.95');
  assert.deepEqual(parts(cardOf(), 'data-chip', 'subagents').map(text), ['1 sub-agents running', '3 in total']);

  await open(opened, 'Deploy the cluster');

  const section = parts(opened.html(), 'data-part', 'subagents')[0];
  assert.equal(parts(section, 'class', 'row item').length, 1);
  assert.equal(parts(section, 'data-agent').length, 3);
  assert.equal(figure(opened.html(), 'cost'), '$1.95');

  // the running sub-agent logs 0.10 USD more, then the refresh's 2 s
  writeScout([...scout, spent(0.1, NOW - minute)]);
  mock.timers.tick(REFRESH_INTERVAL_MS);
  await until(() => figure(opened.html(), 'cost') === '$2.05');
  assert.equal(attr(opened.html(), 'data-screen'), 'session');

  // every command run on `devbox`, for the session and its sub-agents, only reads
  const ran = opened.calls.ssh();
  assert.ok(ran.length > 0);
  assert.deepEqual(ran.filter((args) => args[0] !== 'devbox' || !readOnlyLine(args.at(-1)!)), []);
});
