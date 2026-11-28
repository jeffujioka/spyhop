// The live panel's tabs: it opens on Live, which holds the fleet screen, and the Spend tab reads
// the history store over the range shown, asked again every minute while shown, which the worker
// answers after a catch-up when the last one started nearly a minute ago or more. The controller
// (src/live/controller.ts) runs over the real worker, through the frame the tests play
// (`openLive`, test/helpers/live.ts); the worker's catch-ups read the omp session files with the
// real programs under a temporary home. Time is node:test's mock clock.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock, test } from 'node:test';
import { CATCH_UP_MS, RANGE_REFRESH_MS } from '../../src/core/refresh.js';
import { STORE_FILE } from '../../src/history/store.ts';
import { NOW } from '../helpers/agent-cards.ts';
import { caughtUp } from '../helpers/history.ts';
import { FIX, folderOf, ompCalls, ompSession, type OmpCall, openLive, openOnFleet, spent, titles, until } from '../helpers/live.ts';
import { attr, figure, parts } from '../helpers/markup.ts';

// Writes the session of FIX's agent under `home`.
const fixSession = (home: string) => ompCalls(home, folderOf(home, FIX), { title: 'Fix the login bug', contexts: [] });

// Writes an omp session of the folder `api` under `home` that logs `calls`; written again with
// more calls, it is the same file with those calls added.
const apiSession = (home: string, calls: OmpCall[]) => ompSession(home, join(home, 'api'), { title: 'api', calls });

test('Panel opens on Live', async () => {
  const { html } = await openOnFleet([FIX], { prepare: fixSession });

  const [tab] = parts(html(), 'data-press', 'tab:live');
  assert.equal(attr(tab, 'aria-selected'), 'true');
  assert.deepEqual(titles(html()), ['Fix the login bug']);
  assert.deepEqual(parts(html(), 'data-part', 'range'), []);
});

test("Today's cost while the Spend tab is shown", async () => {
  const first = spent(1);
  const opened = await openLive([], { prepare: (home) => apiSession(home, [first]) });
  const home = process.env.HOME!;
  await caughtUp(home);
  await opened.openTab('spend', 'day');
  assert.equal(figure(opened.html(), 'cost'), '$1.00');
  const fleets = opened.requests('spyhop.fleet');

  apiSession(home, [first, spent(0.25, NOW)]);
  mock.timers.tick(RANGE_REFRESH_MS);

  await until(() => figure(opened.html(), 'cost') === '$1.25');
  assert.equal(opened.requests('spyhop.fleet'), fleets);
});

test('today is read again a minute after an ask the worker took late', async () => {
  const first = spent(1);
  const opened = await openLive([], { prepare: (home) => apiSession(home, [first]) });
  const home = process.env.HOME!;
  await caughtUp(home);
  mock.timers.tick(RANGE_REFRESH_MS);
  // the worker takes the tab's first ask, which starts a catch-up, 5 ms after the panel sent it
  const request = opened.worker.request.bind(opened.worker);
  let held = false;
  opened.worker.request = ((name: string, ...args: unknown[]) => {
    if (name === 'spyhop.range' && !held) {
      held = true;
      mock.timers.tick(5);
    }
    return (request as (name: string, ...args: unknown[]) => Promise<unknown>)(name, ...args);
  }) as typeof opened.worker.request;
  await opened.openTab('spend');
  await caughtUp(home, 2);
  assert.equal(figure(opened.html(), 'cost'), '$1.00');

  apiSession(home, [first, spent(0.25, NOW + RANGE_REFRESH_MS)]);
  // the panel's next ask, 5 ms short of a minute after the worker started the catch-up
  mock.timers.tick(RANGE_REFRESH_MS - 5);

  await until(() => figure(opened.html(), 'cost') === '$1.25');
});

test('a tab pressed during an ask is asked for at its answer', async () => {
  const opened = await openLive([FIX], { prepare: fixSession });
  // the fleet's first ask is out
  opened.live.press('tab:spend');
  opened.live.press('tab:spend');
  assert.equal(opened.requests('spyhop.range'), 0);

  await until(() => opened.requests('spyhop.range') === 1);
  assert.equal(opened.settled('spyhop.fleet'), 1);
  await until(() => opened.settled('spyhop.range') === 1);
  assert.equal(opened.requests('spyhop.range'), 1);
});

test('Catch-up with the panel closed', async () => {
  const opened = await openLive([]);
  opened.live.show(false);
  const home = process.env.HOME!;
  await caughtUp(home);

  apiSession(home, [spent(0.3, NOW)]);
  mock.timers.tick(CATCH_UP_MS);
  await caughtUp(home, 2);
  opened.live.show(true);
  await opened.openTab('spend', 'day');

  assert.equal(figure(opened.html(), 'cost'), '$0.30');
});

test('a store that cannot be opened leaves Live drawn', async () => {
  const opened = await openOnFleet([FIX], {
    prepare: (home) => {
      fixSession(home);
      // the store's folder is a file
      const folder = dirname(join(home, STORE_FILE));
      mkdirSync(dirname(folder), { recursive: true });
      writeFileSync(folder, '');
    },
  });

  assert.deepEqual(titles(opened.html()), ['Fix the login bug']);
  await opened.openTab('spend');
  for (const name of ['cost', 'tokens', 'calls']) assert.equal(figure(opened.html(), name), 'n/a', name);
  assert.equal(opened.worker.logs.filter((line) => line.includes('history store')).length, 1, JSON.stringify(opened.worker.logs));
});

test('a runtime without node:sqlite leaves Live drawn', async () => {
  // the module cannot be loaded from now on, as on a Node that has none or needs a flag for it
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'node:sqlite') throw new Error('No such built-in module: node:sqlite');
      return next(specifier, context);
    },
  });
  try {
    const opened = await openOnFleet([FIX], { prepare: fixSession });

    assert.deepEqual(titles(opened.html()), ['Fix the login bug']);
    await opened.openTab('spend');
    for (const name of ['cost', 'tokens', 'calls']) assert.equal(figure(opened.html(), name), 'n/a', name);
    assert.equal(opened.worker.logs.filter((line) => line.includes('history store')).length, 1, JSON.stringify(opened.worker.logs));
  } finally {
    hooks.deregister();
  }
});

test('a range the store cannot read is n/a', async () => {
  const opened = await openLive([], { prepare: (home) => apiSession(home, [spent(1)]) });
  const home = process.env.HOME!;
  await caughtUp(home);
  // the store loses the view the range is read from
  const db = new DatabaseSync(join(home, STORE_FILE));
  db.exec('DROP VIEW daily_lines');
  db.close();

  await opened.openTab('spend');

  for (const name of ['cost', 'tokens', 'calls']) assert.equal(figure(opened.html(), name), 'n/a', name);
  assert.equal(opened.worker.logs.filter((line) => line.includes('cannot read the history')).length, 1, JSON.stringify(opened.worker.logs));
});

test('One range for the range tabs', async () => {
  const opened = await openLive([], { prepare: (home) => apiSession(home, [spent(1)]) });
  await caughtUp(process.env.HOME!);
  await opened.openTab('spend', 'day');
  opened.live.press('range:month');
  await opened.openTab('cache');

  assert.equal(attr(opened.html(), 'data-tab'), 'cache');
  const [month] = parts(opened.html(), 'data-press', 'range:month');
  assert.equal(attr(month, 'aria-pressed'), 'true');
  // the Cache tab's own chart spans the 30 days of Month
  assert.equal(parts(parts(opened.html(), 'data-chart', 'range-hitRate')[0], 'data-key').length, 30);

  opened.live.press('tab:live');
  await until(() => attr(opened.html(), 'data-screen') === 'fleet');
  assert.deepEqual(parts(opened.html(), 'data-part', 'range'), []);
});

test('a range the store cannot read is n/a on the Cache tab', async () => {
  const opened = await openLive([], { prepare: (home) => apiSession(home, [spent(1)]) });
  const home = process.env.HOME!;
  await caughtUp(home);
  const db = new DatabaseSync(join(home, STORE_FILE));
  db.exec('DROP VIEW daily_lines');
  db.close();

  await opened.openTab('cache', 'week');

  assert.equal(figure(opened.html(), 'hitRate'), 'n/a');
  for (const name of ['cold-expired', 'away-under5', 'compactions']) assert.equal(figure(opened.html(), name), 'n/a', name);
  assert.deepEqual(parts(opened.html(), 'data-part', 'hint'), []);
});
