import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { NA, createSessions, readStats } from '../../src/core/providers/index.js';
import { run } from '../../src/exec.ts';
import { opencodeDatabase } from '../helpers/agent-cards.ts';
import { tempHome } from '../helpers/files.ts';
import { expect } from './helpers/expect.ts';
import { recordingRun } from './helpers/recording-run.ts';

const T0 = 1790000000000;

// Stats of the folder's session as the card builder reads them: link, read, readStats.
async function statsOf(home, cwd, now, exec = run) {
  const hook = createSessions('opencode', { execOn: () => exec, readTextOn: () => async () => null });
  const file = await hook.link({ machine: null, cwd, home, os: 'Darwin', now });
  const input = await hook.read(file, { machine: null, home, now });
  return readStats('opencode', input, now);
}

describe('opencode session', () => {
  test('opencode session details', async () => {
    const home = tempHome();
    opencodeDatabase(home);
    const now = T0 + 530000;
    const { exec, calls } = recordingRun();
    const stats = await statsOf(home, '/work/demo', now, exec);

    expect(stats.harness).toBe('opencode');
    // model and thinking level of the latest assistant turn that is not a compaction summary
    expect(stats.model).toBe('model-b');
    expect(stats.thinkingLevel).toBe('high');
    // first message +0 to the last turn's completion +520000
    expect(stats.durationMs).toBe(520000);
    expect(stats.sinceActivityMs).toBe(10000);
    // every assistant message's total, summaries included: 960 + 950 + 1070 + 1200 + 120 + 0 + 550
    expect(stats.totalTokens).toBe(4850);
    expect(stats.costUsd).toBeCloseTo(0.41, 10);
    expect(stats.burnTokensPerMin).toBeCloseTo(4850 / (520000 / 60000), 10);
    expect(stats.burnCostPerHour).toBeCloseTo(0.41 / (520000 / 3600000), 10);
    // latest turn: prompt of m13 = 10 + 400 + 100; reply +520000 minus its user message +498000
    expect(stats.contextTokens).toBe(510);
    expect(stats.latencyMs).toBe(22000);
    // cache: 2100 read of 1280 input + 2100 read + 1000 write; hits m03 m05 m13, misses m02 m07 m09
    expect(stats.cacheHitRate).toBeCloseTo(2100 / 4380, 10);
    expect(stats.cacheHits).toBe(3);
    expect(stats.cacheMisses).toBe(3);
    // one finished automatic compaction: the manual one and the one that failed do not count
    expect(stats.autocompactions).toBe(1);

    // figures with no source in the database stay n/a
    for (const field of ['contextMax', 'contextPercent', 'headroomTokens', 'cacheLeftMs', 'premiumRequests']) {
      expect(stats[field]).toBe(NA);
    }

    // the database is only ever opened read-only, through sqlite3
    expect(calls.length).toBeGreaterThan(0);
    for (const { command, args } of calls) {
      expect(command).toBe('sqlite3');
      expect(args.slice(0, 2)).toEqual(['-readonly', '-json']);
      expect(args.at(-1)).toMatch(/^SELECT /);
    }
  });

  test('opencode unverified fields are n/a', async () => {
    const home = tempHome();
    opencodeDatabase(home, 'no-cache');
    const stats = await statsOf(home, '/work/legacy', T0 + 40000);

    // what the database holds still shows
    expect(stats.harness).toBe('opencode');
    expect(stats.model).toBe('model-a');
    expect(stats.totalTokens).toBe(1000);
    expect(stats.costUsd).toBeCloseTo(0.05, 10);
    expect(stats.durationMs).toBe(30000);
    // no cache counts and no compaction record: those figures read n/a, never 0
    for (const field of [
      'cacheHitRate',
      'cacheHits',
      'cacheMisses',
      'cacheLeftMs',
      'autocompactions',
      'contextTokens',
      'thinkingLevel',
    ]) {
      expect(stats[field]).toBe(NA);
    }
  });

  test('provider reads plain rows and an unknown compaction count', () => {
    const rows = [
      { id: 'u', role: 'user', created: 0 },
      {
        id: 'a',
        role: 'assistant',
        parentId: 'u',
        created: 1000,
        completed: 3000,
        modelId: 'm',
        cost: 0,
        total: 10,
        input: 4,
        output: 6,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ];
    const stats = readStats('opencode', { messages: rows, compactions: null }, 5000);

    expect(stats.totalTokens).toBe(10);
    expect(stats.costUsd).toBe(0);
    expect(stats.autocompactions).toBe(NA);
    // a session with nothing logged is n/a, not a guess
    const empty = readStats('opencode', { messages: [], compactions: 0 }, 5000);
    expect(empty.model).toBe(NA);
    expect(empty.durationMs).toBe(NA);
    expect(empty.totalTokens).toBe(NA);
    expect(empty.autocompactions).toBe(0);
  });

  test('opencode is read only when its database changed', async () => {
    const home = tempHome();
    const database = opencodeDatabase(home);
    const { exec, calls } = recordingRun();
    const hook = createSessions('opencode', { execOn: () => exec, readTextOn: () => async () => null });
    // what a refresh does: the change check (link), then the read; returns what each ran
    async function refresh(now) {
      calls.length = 0;
      const file = await hook.link({ machine: null, cwd: '/work/demo', home, os: 'Darwin', now });
      const input = await hook.read(file, { machine: null, home, now });
      const queries = calls.map((call) => call.args.at(-1));
      return {
        input,
        link: queries.filter((q) => q.includes('FROM session')).length,
        rows: queries.filter((q) => q.includes('FROM message') || q.includes('FROM part')).length,
      };
    }
    const touch = (at) => {
      execFileSync('sqlite3', [database, `UPDATE session SET time_updated = ${at} WHERE id = 'ses_basic'`]);
    };

    // the first refresh reads the rows (messages and compactions), after the change check
    const now = T0 + 530000;
    const first = await refresh(now);
    expect([first.link, first.rows]).toEqual([1, 2]);
    expect(first.input.messages).toHaveLength(13);

    // the database has not changed: only the change check runs, and the same input comes back
    const unchanged = await refresh(now + 3000);
    expect([unchanged.link, unchanged.rows]).toEqual([1, 0]);
    expect(unchanged.input).toBe(first.input);

    // it changed, but the last read is not 10 s old: still the cached input
    touch(T0 + 531000);
    const soon = await refresh(now + 9000);
    expect([soon.link, soon.rows]).toEqual([1, 0]);
    expect(soon.input).toBe(first.input);

    // it changed and the last read is 10 s old: one re-read
    const later = await refresh(now + 10000);
    expect([later.link, later.rows]).toEqual([1, 2]);
    expect(later.input).not.toBe(first.input);

    // the re-read took in the change: unchanged again, nothing is read
    const settled = await refresh(now + 25000);
    expect([settled.link, settled.rows]).toEqual([1, 0]);
    expect(settled.input).toBe(later.input);
  });
});

describe('opencode session link', () => {
  test('links the folder to its newest top-level session', async () => {
    const home = tempHome();
    opencodeDatabase(home);
    const hook = createSessions('opencode', { execOn: () => run, readTextOn: () => async () => null });
    const link = (cwd, now) => hook.link({ machine: null, cwd, home, os: 'Darwin', now });

    // ses_child is newer and ses_archived newest of the folder, but neither is the Orca agent's
    // session
    const file = await link('/work/demo', T0 + 530000);
    expect(file.path).toBe('ses_basic');
    expect(file.mtimeMs).toBe(T0 + 520000);
    // a folder with a trailing slash is the same folder
    expect((await link('/work/demo/', T0 + 530000)).path).toBe('ses_basic');
    // an idle session is still the folder's session, however long ago it changed
    expect((await link('/work/demo', T0 + 520000 + 6 * 60 * 1000)).path).toBe('ses_basic');
    // an unknown folder, a quote in the name
    expect(await link('/work/nowhere', T0 + 530000)).toBeNull();
    expect(await link("/work/o'brien", T0 + 530000)).toBeNull();
  });

  test('a missing database is no session', async () => {
    const home = tempHome();
    const hook = createSessions('opencode', { execOn: () => run, readTextOn: () => async () => null });

    expect(await hook.link({ machine: null, cwd: '/work/demo', home, os: 'Darwin', now: T0 })).toBeNull();
  });
});
