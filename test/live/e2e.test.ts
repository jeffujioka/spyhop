// The live panel end to end: the real worker, the controller (src/live/controller.ts) and its
// screens, through the frame the tests play (`openLive`, test/helpers/live.ts), over an omp
// session file under a temporary home read by the real programs; from the fleet to the session
// screen, through one refresh, and back. Time is node:test's mock clock.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { REFRESH_INTERVAL_MS } from '../../src/core/refresh.js';
import { NOW } from '../helpers/agent-cards.ts';
import { FIX, folderOf, ompSession, ompWindow, type OmpCall, open, openOnFleet, toolCalls, until } from '../helpers/live.ts';
import { attr, figure, parts, text } from '../helpers/markup.ts';

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
