// The live panel's two screens: it opens on the fleet screen, a card or a folded line opens that
// session's screen, its back control shows the fleet again, and so does a refresh once Orca no
// longer lists the session's agent; the open session screen refreshes as the fleet does, and a
// change of Orca's theme redraws nothing. The controller (src/live/controller.ts) runs over the
// real worker, through the frame the tests play (`openLive`, test/helpers/live.ts); the worker
// reads the omp session files with the real programs under a temporary home. Time is node:test's
// mock clock.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { REFRESH_INTERVAL_MS } from '../../src/core/refresh.js';
import { STYLE } from '../../src/live/style.ts';
import { NOW } from '../helpers/agent-cards.ts';
import { FIX, folderOf, ompCalls, ompSession, type OmpCall, open, openOnFleet, pressOf, titles, until } from '../helpers/live.ts';
import { attr, figure, parts, text } from '../helpers/markup.ts';
import type { HostWorkspace } from '../helpers/orca-host.ts';

// Two more of this computer's workspaces beside `FIX` (test/helpers/live.ts), each with one omp
// agent titled `π - <title>`, whose session `prepare` writes in a folder of the workspace.
const DOCS: HostWorkspace = { project: 'web', name: 'docs', agents: ['working'], title: 'π - Write the docs' };
const TUNNEL: HostWorkspace = { project: 'ops', name: 'tunnel', agents: ['done'], title: 'π - Review the tunnel' };

// Writes the session of each of `workspaces` under `home`, titled as its agent is.
const sessions = (workspaces: HostWorkspace[]) => (home: string) => {
  for (const ws of workspaces) ompCalls(home, folderOf(home, ws), { title: ws.title!.slice('π - '.length), contexts: [] });
};

// The screen `html` is (`data-screen`).
const screenOf = (html: string) => attr(html, 'data-screen');

// The panel opened on `workspaces`, once it has drawn the fleet's whole answer; `prepare` writes
// their sessions unless given.
const openWith = (workspaces: HostWorkspace[], prepare = sessions(workspaces)) => openOnFleet(workspaces, { prepare });

test('Panel opens on the fleet screen', async () => {
  const { html } = await openWith([FIX]);

  assert.equal(screenOf(html()), 'fleet');
  assert.deepEqual(titles(html()), ['Fix the login bug']);
  assert.doesNotMatch(html(), /data-screen="session"/);
});

test('Card opens the session screen', async () => {
  const opened = await openWith([FIX, DOCS]);
  assert.deepEqual(titles(opened.html()), ['Fix the login bug', 'Write the docs']);

  await open(opened, 'Fix the login bug');

  assert.equal(screenOf(opened.html()), 'session');
  assert.deepEqual(titles(opened.html()), ['Fix the login bug']);
  assert.doesNotMatch(text(opened.html()), /Write the docs/);
});

test('Folded line opens the session screen', async () => {
  const opened = await openWith([TUNNEL]);
  assert.equal(parts(opened.html(), 'data-part', 'folded').length, 1);

  await open(opened, 'Review the tunnel');

  assert.equal(screenOf(opened.html()), 'session');
  assert.deepEqual(titles(opened.html()), ['Review the tunnel']);
});

test('Back returns to the fleet screen', async () => {
  const opened = await openWith([FIX]);
  await open(opened, 'Fix the login bug');
  const fleets = opened.requests('spyhop.fleet');

  opened.live.press('back');

  assert.equal(screenOf(opened.html()), 'fleet');
  assert.deepEqual(titles(opened.html()), ['Fix the login bug']);
  // it asks for the fleet at once
  assert.equal(opened.requests('spyhop.fleet'), fleets + 1);
});

test('Session whose agent is gone', async () => {
  const opened = await openWith([FIX, DOCS]);
  await open(opened, 'Fix the login bug');

  opened.host.remove('main');
  mock.timers.tick(REFRESH_INTERVAL_MS);

  await until(() => screenOf(opened.html()) === 'fleet' && titles(opened.html()).length === 1);
  assert.deepEqual(titles(opened.html()), ['Write the docs']);
  assert.doesNotMatch(text(opened.html()), /Fix the login bug/);
});

test('Theme change without a reload', async () => {
  const opened = await openWith([FIX]);
  await open(opened, 'Fix the login bug');
  const [drawn, draws] = [opened.html(), opened.draws()];
  const asked = opened.requests('spyhop.session') + opened.requests('spyhop.fleet');

  opened.frame.emitTheme('light');

  // the stylesheet's variables change in place: nothing is drawn or asked again
  assert.equal(opened.draws(), draws);
  assert.equal(opened.html(), drawn);
  assert.equal(opened.requests('spyhop.session') + opened.requests('spyhop.fleet'), asked);
  assert.deepEqual(titles(opened.html()), ['Fix the login bug']);
  // the plugin's colours are set once for each theme, and the markup holds none of its own
  const block = (theme: string) => new RegExp(`html\\.${theme} \\{([^}]*)\\}`).exec(STYLE)![1];
  const value = (theme: string, name: string) => new RegExp(`--spy-${name}: ([^;]+);`).exec(block(theme))![1];
  for (const name of ['ok', 'warning', 'hot', 'critical', 's1']) assert.notEqual(value('light', name), value('dark', name), name);
  assert.doesNotMatch(drawn, /#[0-9a-fA-F]{3,8}\b|rgb\(/);
});

test('Open session screen refreshes', async () => {
  // four model calls, the first of 0.10 USD; the fifth brings the cost to 0.25 USD
  const call = (i: number, cost = 0): OmpCall => ({ at: NOW - 60_000 + i * 1000, uncached: 100, output: 10, cost: i === 0 ? 0.1 : cost });
  const calls = [0, 1, 2, 3].map((i) => call(i));
  const write = (home: string, logged: OmpCall[]) => ompSession(home, folderOf(home, FIX), { title: 'Fix the login bug', calls: logged });
  let home = '';
  const opened = await openWith([FIX], (at) => {
    home = at;
    write(home, calls);
  });
  await open(opened, 'Fix the login bug');
  assert.equal(figure(opened.html(), 'cost'), '$0.10');
  assert.equal(parts(parts(opened.html(), 'data-chart', 'tokens')[0], 'data-bar').length, 4);

  // the file is written again with the four calls as they were, then the fifth: an append
  write(home, [...calls, call(4, 0.15)]);
  mock.timers.tick(REFRESH_INTERVAL_MS);

  await until(() => figure(opened.html(), 'cost') === '$0.25');
  assert.equal(screenOf(opened.html()), 'session');
  assert.equal(parts(parts(opened.html(), 'data-chart', 'tokens')[0], 'data-bar').length, 5);
});

// The page keeps its scroll position only across drawings of one screen (src/panel.ts): the
// fleet, or the session of one card. A guard of the controller's part of it, no scenario of the
// spec: the Node tests have no layout to scroll.
test('a new screen starts at the top, a refreshed one where it was', async () => {
  // whether each drawing since the last step is of the screen drawn before it
  let same: boolean[] = [];
  const step = () => {
    const seen = same;
    same = [];
    return seen;
  };
  const opened = await openOnFleet([FIX], { prepare: sessions([FIX]), onDraw: (_, { sameScreen }) => same.push(sameScreen) });
  // the first drawing, then the fleet's answer over its loading line
  const first = step();
  assert.deepEqual([first[0], first.slice(1).every(Boolean), first.length > 1], [false, true, true]);

  await open(opened, 'Fix the login bug');
  assert.deepEqual(step(), [false, true]);

  mock.timers.tick(REFRESH_INTERVAL_MS);
  await until(() => same.length > 0);
  assert.deepEqual(step(), [true]);

  opened.live.press('back');
  assert.deepEqual(step(), [false]);

  await until(() => screenOf(opened.html()) === 'fleet' && same.length > 0);
  assert.ok(step().every(Boolean));
});

test('a card id with a NUL opens its screen', async () => {
  const opened = await openWith([FIX]);
  const press = pressOf(opened.html(), 'Fix the login bug');
  const id = decodeURIComponent(press.slice('open:'.length));
  // the workspace's id, which holds `::` and slashes, then a NUL and the terminal's id
  assert.match(id, /^repo:api::\/.+\0api-main-0$/);
  assert.equal(press, `open:${encodeURIComponent(id)}`);

  await open(opened, 'Fix the login bug');

  assert.deepEqual(titles(opened.html()), ['Fix the login bug']);
  assert.equal(figure(opened.html(), 'cost'), '$0.10');
});
