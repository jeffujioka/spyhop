// The catch-up of this computer's omp sessions: each run reads the session files under the home
// into the history store, each from where its last read ended. The store, the runner and the
// programs are the real ones, under a temporary home; the runner records each call
// (test/core/helpers/recording-run.ts).
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, mock, test } from 'node:test';
import { CATCH_UP_MS } from '../../src/core/refresh.js';
import { ompSessionsDir } from '../../src/core/providers/omp-sources.js';
import { createCatchUp } from '../../src/history/catch-up.ts';
import { openStore, STORE_FILE, type Store } from '../../src/history/store.ts';
import { scheduleCatchUps } from '../../src/worker.ts';
import { expect } from '../core/helpers/expect.ts';
import { recordingRun } from '../core/helpers/recording-run.ts';
import { NOW, ompSessionDir } from '../helpers/agent-cards.ts';
import { setEnv, useTempHome } from '../helpers/env.ts';
import { caughtUp, storeOf } from '../helpers/history.ts';
import { ompSession, ompSubAgent, spent } from '../helpers/live.ts';

let store: Store | undefined;
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
  store?.close();
  store = undefined;
  mock.timers.reset();
});

// A catch-up over a new temporary home, through the recording runner, in UTC.
async function catchUpOf() {
  setEnv('TZ', 'UTC');
  const home = useTempHome();
  const { exec, calls } = recordingRun();
  const logs: string[] = [];
  store = await openStore(home);
  const catchUp = createCatchUp({ run: exec, store, home, log: (message) => logs.push(message) });
  return { home, calls, logs, store, catchUp };
}

// The omp session file `ompSession` wrote for the folder `path` under `home`.
const sessionFileOf = (home: string, path: string) => {
  const dir = ompSessionDir(home, path);
  return join(dir, readdirSync(dir).find((name) => name.endsWith('.jsonl'))!);
};

// The cost of the daily lines of `day` in `store`, by repo.
const costByRepo = (store: Store, day: string) => Object.fromEntries(store.dailyLines(day, day).map(({ repo, figures }) => [repo, figures.cost]));

// Epoch ms of 12:00 UTC on `day` (YYYY-MM-DD).
const noonOf = (day: string) => Date.parse(`${day}T12:00:00.000Z`);

const TODAY = '2026-11-25';

describe('catch-up', () => {
  test('Folder without an origin', async () => {
    const { home, store, catchUp } = await catchUpOf();
    const scratch = join(home, 'scratch');
    ompSession(home, scratch, { title: 'scratch', calls: [spent(0.4)] });

    await catchUp.run();

    expect(costByRepo(store, TODAY)).toEqual({ [scratch]: 0.4 });
  });

  test('Unchanged file not read', async () => {
    const { home, calls, catchUp } = await catchUpOf();
    const folder = join(home, 'api');
    ompSession(home, folder, { title: 'api', calls: [spent(0.4)] });
    const file = sessionFileOf(home, folder);
    await catchUp.run();
    const mark = calls.length;

    await catchUp.run();

    const reads = calls.slice(mark).filter(({ command, args }) => ['tail', 'dd'].includes(command) && args.some((arg) => arg.includes(file)));
    expect(reads).toEqual([]);
  });

  test("an unchanged file's kept state is not decoded", async () => {
    const { home, logs, catchUp } = await catchUpOf();
    ompSession(home, join(home, 'api'), { title: 'api', calls: [spent(0.4)] });
    await catchUp.run();
    // a state no decode can read: a run that decoded it would log the file as not read
    const db = new DatabaseSync(join(home, STORE_FILE));
    db.exec("UPDATE files SET state = 'not json'");
    db.close();

    await catchUp.run();

    expect(logs).toEqual([]);
  });

  test('Replaced file counted once', async () => {
    const { home, store, catchUp } = await catchUpOf();
    const folder = join(home, 'api');
    const day = '2026-11-27';
    ompSession(home, folder, { title: 'api', calls: [spent(1, noonOf(day)), spent(1, noonOf(day) + 1000)] });
    await catchUp.run();
    expect(costByRepo(store, day)).toEqual({ [folder]: 2 });

    ompSession(home, folder, { title: 'api', calls: [spent(0.5, noonOf(day))] });
    await catchUp.run();

    expect(costByRepo(store, day)).toEqual({ [folder]: 0.5 });
  });

  test('Nothing between catch-ups', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
    const { home, calls, catchUp } = await catchUpOf();
    ompSession(home, join(home, 'api'), { title: 'api', calls: [spent(0.4)] });
    // the listings of omp's sessions folder: one a run
    const finds = () => calls.filter(({ command, args }) => command === 'find' && args.includes(ompSessionsDir(home))).length;
    stop = scheduleCatchUps(catchUp, () => {});
    await caughtUp(home);
    const mark = calls.length;

    mock.timers.tick(CATCH_UP_MS - 60_000);
    await setImmediate();
    await setImmediate();
    expect(calls.length).toBe(mark);

    mock.timers.tick(60_000);
    await caughtUp(home, 2);
    expect(finds()).toBe(2);
  });

  test('a line being written is counted once', async () => {
    const { home, store, catchUp } = await catchUpOf();
    const folder = join(home, 'api');
    ompSession(home, folder, { title: 'api', calls: [spent(0.1), spent(0.2, NOW - 30_000)] });
    const file = sessionFileOf(home, folder);
    // the last call's line, its newline not written yet
    writeFileSync(file, readFileSync(file, 'utf8').slice(0, -1));
    await catchUp.run();
    expect(costByRepo(store, TODAY)).toEqual({ [folder]: 0.1 });

    appendFileSync(file, '\n');
    await catchUp.run();
    await catchUp.run();

    expect(costByRepo(store, TODAY)[folder]).toBeCloseTo(0.3, 9);
  });

  test("a sub-agent transcript counts in its own folder's repo", async () => {
    const { home, catchUp } = await catchUpOf();
    const origin = 'git@github.com:jeffujioka/spyhop.git';
    const project = join(home, 'spyhop');
    const other = join(home, 'other');
    mkdirSync(other, { recursive: true });
    ompSession(home, project, { title: 'spyhop', calls: [spent(1)] });
    execFileSync('git', ['init', '-q'], { cwd: project });
    execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: project });
    const transcript = ompSubAgent(home, project, 'Impl1', { calls: [spent(0.3)] });
    const sessionEntry = { type: 'session', version: 3, id: 'sub1', timestamp: new Date(NOW - 90_000).toISOString(), cwd: other };
    writeFileSync(transcript, `${JSON.stringify(sessionEntry)}\n${readFileSync(transcript, 'utf8')}`);

    await catchUp.run();

    const db = storeOf(home);
    const rows = db.prepare('SELECT session, repo, SUM(cost) AS cost FROM lines GROUP BY session, repo ORDER BY cost').all();
    db.close();
    const session = `local\0omp\0${sessionFileOf(home, project)}`;
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { session, repo: other, cost: 0.3 },
      { session, repo: origin, cost: 1 },
    ]);
  });

  test('a sessions folder that cannot be listed is logged and ends no run', async () => {
    const { home, logs, store, catchUp } = await catchUpOf();
    ompSession(home, join(home, 'api'), { title: 'api', calls: [spent(0.4)] });
    const dir = ompSessionsDir(home);
    // a folder under the sessions folder that `find` cannot go into
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0);
    try {
      await catchUp.run();
    } finally {
      chmodSync(locked, 0o700);
    }

    expect(logs.filter((line) => line.startsWith(`spyhop: catch-up cannot list ${dir}: `))).toHaveLength(1);
    expect(store.meta('catch-ups')).toBe(null);
  });
});
