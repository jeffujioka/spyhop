// The first catch-up, made useful sooner: on every Orca host it reads the files of the last
// FIRST_DAYS days before any older one, newest first, while the Spend tab shows which Orca host
// and harness it is reading and the share of its bytes read, and the fleet refreshes as ever. A
// test has no other host, so it stands in for `orca` and `ssh` only (test/helpers/stand-ins.ts):
// `orca host list` lists the SSH host `starfish-bs`, whose commands run here under its own home
// folder, held back where a test says. The worker, the store and every other program are the
// real ones.
import assert from 'node:assert/strict';
import { appendFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { dayOf } from '../../src/core/days.js';
import { RANGE_REFRESH_MS, REFRESH_INTERVAL_MS } from '../../src/core/refresh.js';
import { run, type Run, runBytes } from '../../src/exec.ts';
import { createCatchUp } from '../../src/history/catch-up.ts';
import { openStore, type Store } from '../../src/history/store.ts';
import { historyHosts, listHosts } from '../../src/hosts.ts';
import { NOW, ompSessionOf, opencodeSession } from '../helpers/agent-cards.ts';
import { setEnv, useTempHome } from '../helpers/env.ts';
import { tempHome } from '../helpers/files.ts';
import { caughtUp, storeOf } from '../helpers/history.ts';
import { FIX, folderOf, ompSession, type OmpCall, openLive, openOnFleet, spent, until } from '../helpers/live.ts';
import { figure, parts, text } from '../helpers/markup.ts';
import { STARFISH_LISTS } from '../helpers/orca-answers.ts';
import { standIns } from '../helpers/stand-ins.ts';

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The omp session file of the folder `folder` under `home`, a session of 0.10 USD padded to
// `bytes` bytes, last changed at `at` (epoch ms); returns its path.
function ompFile(home: string, folder: string, bytes: number, at: number) {
  const file = ompSessionOf(home, join(home, folder), 0.1);
  const empty = `${JSON.stringify({ type: 'custom', note: '' })}\n`.length;
  appendFileSync(file, `${JSON.stringify({ type: 'custom', note: 'x'.repeat(bytes - statSync(file).size - empty) })}\n`);
  utimesSync(file, at / 1000, at / 1000);
  return file;
}

test('Progress line', async () => {
  const remoteHome = tempHome();
  // omp's sessions on starfish-bs: 34 KB changed an hour ago and 66 KB two hours ago, whose reads
  // are held
  ompFile(remoteHome, 'api', 34_000, NOW - HOUR_MS);
  const older = ompFile(remoteHome, 'web', 66_000, NOW - 2 * HOUR_MS);
  const held = `ssh starfish-bs ${older}`;
  let home = '';
  const opened = await openLive([], {
    homes: { 'starfish-bs': remoteHome },
    orca: STARFISH_LISTS,
    held: [held],
    prepare: (at) => {
      home = at;
    },
  });
  await until(() => opened.calls.ssh().some((args) => args.at(-1)!.includes(older)));

  await opened.openTab('spend', 'week');

  assert.equal(text(parts(opened.html(), 'data-part', 'progress')[0] ?? ''), 'Reading history: starfish-bs, omp, 34%');
  opened.calls.release(held);
  await caughtUp(home);
  // the panel's next ask of the tab, once the catch-up has ended
  const answered = opened.settled('spyhop.range');
  mock.timers.tick(RANGE_REFRESH_MS);
  await until(() => opened.settled('spyhop.range') > answered);
  await setImmediate();
  assert.deepEqual(parts(opened.html(), 'data-part', 'progress'), []);
});

// A guard of the opencode read, no scenario of the spec: the count of the calls to read, which
// only the progress line needs, runs only until the database is read through, and a count that
// fails leaves the calls read.
test('a count of opencode calls that fails still reads them', async () => {
  setEnv('TZ', 'UTC');
  const home = useTempHome();
  // a call of 0.20 USD created 3 days ago, in a database whose other calls are of other days
  const last = Date.now() - 3 * DAY_MS;
  opencodeSession(home, join(home, 'web'), { provider: 'anthropic', model: 'claude-opus-5.5', calls: [{ uncached: 100, read: 0, write: 0, output: 50 }], cost: 0.2, callCost: 0.2, last });
  // each count asked, which sqlite3 fails
  const counts: string[] = [];
  const failingCount: Run = (command, args, options) => {
    if (command !== 'sqlite3' || !args.at(-1)!.startsWith('SELECT count(*)')) return run(command, args, options);
    counts.push(args.at(-1)!);
    return Promise.resolve({ code: 1, stdout: '', stderr: 'Error: interrupted' });
  };
  store = await openStore(home);
  const catchUp = createCatchUp({ run: failingCount, runBytes, store, home, log: () => {}, hosts: async () => [] });

  await catchUp.run();
  await catchUp.run();

  const db = storeOf(home);
  const { cost } = db.prepare("SELECT SUM(cost) AS cost FROM lines JOIN files ON files.id = lines.file WHERE harness = 'opencode' AND day = ?").get(dayOf(last))!;
  db.close();
  assert.equal(Math.round(Number(cost) * 100) / 100, 0.2);
  assert.equal(counts.length, 1);
});

test('Last 30 days first', async () => {
  setEnv('TZ', 'UTC');
  const home = useTempHome();
  const remoteHome = tempHome();
  const now = Date.now();
  const recent = ompFile(home, 'api', 2_000, now - 3 * DAY_MS);
  const old = ompFile(home, 'web', 2_000, now - 90 * DAY_MS);
  const remote = ompFile(remoteHome, 'cli', 2_000, now - 5 * DAY_MS);
  standIns({ homes: { 'starfish-bs': remoteHome }, orca: STARFISH_LISTS });
  store = await openStore(home);
  const catchUp = createCatchUp({ run, runBytes, store, home, log: () => {}, hosts: async () => historyHosts(await listHosts(run)) });

  await catchUp.run();

  const db = storeOf(home);
  const paths = db.prepare("SELECT path FROM files WHERE harness = 'omp' ORDER BY id").all().map(({ path }) => String(path));
  db.close();
  assert.deepEqual(paths.toSorted(), [recent, old, remote].toSorted());
  assert.ok(paths.indexOf(old) > paths.indexOf(recent) && paths.indexOf(old) > paths.indexOf(remote), JSON.stringify(paths));
});

test('Live during the first read', async () => {
  const remoteHome = tempHome();
  ompFile(remoteHome, 'api', 2_000, NOW - HOUR_MS);
  let home = '';
  const write = (calls: OmpCall[]) => ompSession(home, folderOf(home, FIX), { title: 'Fix the login bug', calls });
  const opened = await openOnFleet([FIX], {
    homes: { 'starfish-bs': remoteHome },
    orca: STARFISH_LISTS,
    held: ['ssh starfish-bs'],
    prepare: (at) => {
      home = at;
      write([spent(0.1)]);
    },
  });
  try {
    // the first catch-up waits on starfish-bs
    await until(() => opened.calls.ssh().some(([alias]) => alias === 'starfish-bs'));
    const cardOf = () => parts(opened.html(), 'data-part', 'card')[0] ?? '';
    assert.equal(figure(cardOf(), 'cost'), '$0.10');

    // one more model call, then the refresh's 2 s
    write([spent(0.1), spent(0.15, NOW - 30_000)]);
    mock.timers.tick(REFRESH_INTERVAL_MS);

    await until(() => figure(cardOf(), 'cost') === '$0.25');
  } finally {
    opened.calls.release('ssh starfish-bs');
  }
});
