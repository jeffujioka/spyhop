// The history store: the SQLite file under the home that keeps the daily lines of the session
// files a catch-up read, for good. The store is the real one, on `node:sqlite`, in a temporary
// home.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, test } from 'node:test';
import { LINE_FIGURES } from '../../src/core/insights.js';
import { HISTORY_VERSION, STORE_FILE, openStore, type FileRow, type Store } from '../../src/history/store.ts';
import { expect } from '../core/helpers/expect.ts';
import { tempHome } from '../helpers/files.ts';

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

const open = async (home = tempHome()) => (store = await openStore(home));

// Figures of a daily line: each LINE_FIGURES name 0, but those of `some`.
const figuresOf = (some: Record<string, number> = {}) => ({ ...Object.fromEntries(LINE_FIGURES.map((name) => [name, 0])), ...some });

// The row of the file `path` of omp on `host`, read up to `pos`, with `state`.
const fileOf = (path: string, host = 'local', state: unknown = null): Omit<FileRow, 'id'> => ({
  host,
  harness: 'omp',
  path,
  pos: 100,
  size: 100,
  mtimeMs: 1_000,
  version: HISTORY_VERSION,
  state,
});

// A read of session `session` in repo `repo` adding `cost` USD and one call on `day` to model `m`.
const readOf = (cost: number, { day = '2026-11-27', session = 's', repo = 'git@github.com:jeffujioka/spyhop.git', restarted = false } = {}) => ({
  session,
  repo,
  lines: [{ day, model: 'm', figures: figuresOf({ calls: 1, cost }) }],
  restarted,
});

describe('history store', () => {
  test('the store and its folder are created', async () => {
    const home = tempHome();
    await open(home);

    expect(STORE_FILE).toBe('.local/state/spyhop/insights.db');
    expect(existsSync(join(home, STORE_FILE))).toBe(true);
  });

  test('lines of one key add up', async () => {
    const s = await open();
    s.saveRead(fileOf('/a.jsonl'), readOf(1));
    s.saveRead(fileOf('/a.jsonl'), readOf(0.5));

    const lines = s.dailyLines('2026-11-27', '2026-11-27');
    expect(lines).toHaveLength(1);
    expect(lines[0].figures.cost).toBeCloseTo(1.5);
    expect(lines[0].figures.calls).toBe(2);
  });

  test("a restarted read replaces the file's lines and leaves the others", async () => {
    const s = await open();
    s.saveRead(fileOf('/a.jsonl'), readOf(2));
    s.saveRead(fileOf('/b.jsonl'), readOf(1, { session: 't' }));
    expect(s.dailyLines('2026-11-27', '2026-11-27')[0].figures.cost).toBeCloseTo(3);

    s.saveRead(fileOf('/a.jsonl'), readOf(0.5, { restarted: true }));

    const lines = s.dailyLines('2026-11-27', '2026-11-27');
    expect(lines).toHaveLength(1);
    expect(lines[0].figures.cost).toBeCloseTo(1.5);
  });

  test('two Orca hosts give two daily lines', async () => {
    const s = await open();
    s.saveRead(fileOf('/a.jsonl', 'local'), readOf(1));
    s.saveRead(fileOf('/a.jsonl', 'ssh:bs'), readOf(2));

    const lines = s.dailyLines('2026-11-27', '2026-11-27').sort((a, b) => a.host.localeCompare(b.host));
    expect(lines).toEqual([
      { day: '2026-11-27', host: 'local', repo: 'git@github.com:jeffujioka/spyhop.git', harness: 'omp', model: 'm', figures: figuresOf({ calls: 1, cost: 1 }) },
      { day: '2026-11-27', host: 'ssh:bs', repo: 'git@github.com:jeffujioka/spyhop.git', harness: 'omp', model: 'm', figures: figuresOf({ calls: 1, cost: 2 }) },
    ]);
  });

  test('a state reads back as it was saved', async () => {
    const s = await open();
    const state = { byModel: new Map([['m', { cost: NaN, calls: 2 }]]), cwd: '/home/u/proj', last: undefined };
    const id = s.saveRead(fileOf('/a.jsonl', 'local', state), readOf(1));

    const { state: saved, ...mark } = fileOf('/a.jsonl', 'local', state);
    expect(s.file('local', 'omp', '/a.jsonl')).toEqual({ id, ...mark });
    expect(s.state(id)).toEqual(saved);
    expect(s.file('local', 'omp', '/b.jsonl')).toBeNull();
  });

  test('a store of an older figure list gains its columns', async () => {
    const home = tempHome();
    (await open(home)).close();
    store = undefined;
    // the store as a version that knew only `calls` and `cost` wrote it
    const db = new DatabaseSync(join(home, STORE_FILE));
    db.exec('DROP VIEW daily_lines');
    db.exec('DROP TABLE lines');
    db.exec(`CREATE TABLE lines (file INTEGER NOT NULL, session TEXT NOT NULL, day TEXT NOT NULL, repo TEXT NOT NULL,
      model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, PRIMARY KEY (file, session, day, repo, model))`);
    db.close();

    const s = await open(home);
    s.saveRead(fileOf('/a.jsonl'), readOf(1));

    expect(s.dailyLines('2026-11-27', '2026-11-27')[0].figures).toEqual(figuresOf({ calls: 1, cost: 1 }));
  });

  test('a meta value reads back as it was set', async () => {
    const s = await open();
    expect(s.meta('caughtUp')).toBeNull();
    s.setMeta('caughtUp', '2026-11-27');
    expect(s.meta('caughtUp')).toBe('2026-11-27');
  });

  test('a write waits for another process that holds the store', async () => {
    const home = tempHome();
    const s = await open(home);
    // another process, as the dev plugin beside a test run or `sqlite3`, writing for 300 ms: a
    // real delay, as the store's write blocks in SQLite's own wait, which no mock clock drives
    const other = spawn(process.execPath, [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      db.exec("INSERT INTO meta (key, value) VALUES ('other', '1')");
      console.log('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);`,
      join(home, STORE_FILE),
    ]);
    await once(other.stdout, 'data');

    s.setMeta('caughtUp', '2026-11-27');

    await once(other, 'exit');
    expect(s.meta('caughtUp')).toBe('2026-11-27');
    expect(s.meta('other')).toBe('1');
  });
});
