import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { NA, createSessions, readStats } from '../../src/core/providers/index.js';
import { run } from '../../src/exec.ts';
import { opencodeDatabase, sqlText } from '../helpers/agent-cards.ts';
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

  test('current rows give the same figures as legacy rows', async () => {
    const home = tempHome();
    opencodeDatabase(home, 'current');
    const now = T0 + 140000;
    const { exec, calls } = recordingRun();
    // one session written in each generation's shape (see current.sql)
    const current = await statsOf(home, '/work/twin', now, exec);
    const legacy = await statsOf(home, '/work/twin-legacy', now, exec);

    // the current tables record no message a reply answers and no automatic compaction, so the
    // last turn's latency and the autocompactions read n/a there, never a guess
    expect(current.latencyMs).toBe(NA);
    expect(current.autocompactions).toBe(NA);
    expect(legacy.latencyMs).toBe(10000);
    expect(legacy.autocompactions).toBe(1);
    const { latencyMs: _currentLatency, autocompactions: _currentCompactions, ...currentFigures } = current;
    const { latencyMs: _legacyLatency, autocompactions: _legacyCompactions, ...legacyFigures } = legacy;
    expect(currentFigures).toEqual(legacyFigures);

    // the figures themselves: the compaction's cost is the session's, its model is not
    expect(current.model).toBe('claude-haiku-5.5');
    expect(current.thinkingLevel).toBe('high');
    expect(current.costUsd).toBeCloseTo(0.45, 10);
    expect(current.totalTokens).toBe(960 + 1200 + 950);
    expect(current.contextTokens).toBe(920);
    expect(current.durationMs).toBe(130000);
    // the whole session's detail: three model calls, the compaction's included, one mark, the
    // tool calls by tool with the one that failed, and the models by cost and tokens
    expect(current.detail.points.map((point) => [point.t - T0, point.context, point.cost])).toEqual([
      [5000, 900, 0.3],
      [61000, 1000, 0.01],
      [130000, 920, 0.14],
    ]);
    expect(current.detail.marks).toEqual([{ t: T0 + 61000, before: null, after: null }]);
    expect(current.detail.tools).toEqual({ bash: { calls: 3, failed: 1 }, read: { calls: 1, failed: 0 } });
    expect(Object.keys(current.detail.models)).toEqual(['p/claude-haiku-5.5', 'p/model-c']);
    expect(current.detail.models['p/claude-haiku-5.5'].tokens).toBe(960 + 950);
    expect(current.detail.cold).toEqual({ count: 1, tokens: 0, cost: null });
    expect([current.detail.start - T0, current.detail.end - T0]).toEqual([0, 130000]);

    // the database is only ever opened read-only, through sqlite3
    for (const { command, args } of calls) {
      expect(command).toBe('sqlite3');
      expect(args.slice(0, 2)).toEqual(['-readonly', '-json']);
      expect(args.at(-1)).toMatch(/^SELECT /);
    }
  });

  test('opencode is read only when its database changed', async () => {
    const home = tempHome();
    const database = opencodeDatabase(home);
    const { exec, calls } = recordingRun();
    const hook = createSessions('opencode', { execOn: () => exec, readTextOn: () => async () => null });
    // what a refresh does: the change check (link), then the read; returns what each ran. The
    // change check is one query, after the lookup of which session tables the database has: this
    // database has the legacy ones alone, which is looked up again at each refresh (see 'a legacy
    // database upgraded in place links its new session').
    async function refresh(now) {
      calls.length = 0;
      const file = await hook.link({ machine: null, cwd: '/work/demo', home, os: 'Darwin', now });
      const input = await hook.read(file, { machine: null, home, now });
      const queries = calls.map((call) => call.args.at(-1));
      return {
        input,
        schema: queries.filter((q) => q.includes('FROM sqlite_master')).length,
        link: queries.filter((q) => q.includes('FROM session')).length,
        rows: queries.filter((q) => q.includes('FROM message') || q.includes('FROM part')).length,
      };
    }
    const touch = (at) => {
      execFileSync('sqlite3', [database, `UPDATE session SET time_updated = ${at} WHERE id = 'ses_basic'`]);
    };

    // the first refresh reads the rows (messages, tool calls and compactions), after the change
    // check
    const now = T0 + 530000;
    const first = await refresh(now);
    expect([first.schema, first.link, first.rows]).toEqual([1, 1, 3]);
    expect(first.input.messages).toHaveLength(13);

    // the database has not changed: only the change check runs, and the same rows come back (the
    // input around them is new at each read, with the window of the catalogue)
    const unchanged = await refresh(now + 3000);
    expect([unchanged.schema, unchanged.link, unchanged.rows]).toEqual([1, 1, 0]);
    expect(unchanged.input.messages).toBe(first.input.messages);

    // it changed, but the last read is not 10 s old: still the cached rows
    touch(T0 + 531000);
    const soon = await refresh(now + 9000);
    expect([soon.link, soon.rows]).toEqual([1, 0]);
    expect(soon.input.messages).toBe(first.input.messages);

    // it changed and the last read is 10 s old: one re-read
    const later = await refresh(now + 10000);
    expect([later.link, later.rows]).toEqual([1, 3]);
    expect(later.input.messages).not.toBe(first.input.messages);

    // the re-read took in the change: unchanged again, nothing is read
    const settled = await refresh(now + 25000);
    expect([settled.schema, settled.link, settled.rows]).toEqual([1, 1, 0]);
    expect(settled.input.messages).toBe(later.input.messages);
  });

  test('a session found in the other tables is read from them at once', async () => {
    const home = tempHome();
    const database = opencodeDatabase(home, 'current');
    const hook = createSessions('opencode', { execOn: () => run, readTextOn: () => async () => null });
    async function refresh(now) {
      const file = await hook.link({ machine: null, cwd: '/work/legacy', home, os: 'Darwin', now });
      return readStats('opencode', await hook.read(file, { machine: null, home, now }), now);
    }

    // ses_legacy is in the legacy tables alone: its cost there is 0.10
    const now = T0 + 140000;
    expect((await refresh(now)).costUsd).toBeCloseTo(0.1, 10);

    // opencode then writes it into the current tables, with ses_current's rows (0.30 and 0.14);
    // the next refresh, though less than 10 s later, reads it from there, never the legacy copy
    execFileSync('sqlite3', [
      database,
      "INSERT INTO session_v2 VALUES ('ses_legacy', 'prj', NULL, 's', '/work/legacy', 't', '2.0.0', 0.44, NULL, NULL, 1790000000000, 1790000131000, NULL); " +
        "INSERT INTO session_message SELECT 'm' || id, 'ses_legacy', type, seq, time_created, time_updated, data FROM session_message WHERE session_id = 'ses_current';",
    ]);
    expect((await refresh(now + 3000)).costUsd).toBeCloseTo(0.44, 10);
  });

  test('a legacy database upgraded in place links its new session', async () => {
    const home = tempHome();
    const database = opencodeDatabase(home);
    const { exec, calls } = recordingRun();
    const hook = createSessions('opencode', { execOn: () => exec, readTextOn: () => async () => null });
    // a refresh: the session the folder links (null when none can be read), its cost, and how
    // many lookups of the session tables it ran
    async function refresh(now) {
      calls.length = 0;
      const file = await hook.link({ machine: null, cwd: '/work/demo', home, os: 'Darwin', now });
      const costUsd = file && readStats('opencode', await hook.read(file, { machine: null, home, now }), now).costUsd;
      const schema = calls.filter((call) => call.args.at(-1).includes('FROM sqlite_master')).length;
      return { path: file?.path ?? null, costUsd, schema };
    }

    // the database has the legacy tables alone: the folder links ses_basic
    const now = T0 + 530000;
    const legacy = await refresh(now);
    expect([legacy.path, legacy.schema]).toEqual(['ses_basic', 1]);
    expect(legacy.costUsd).toBeCloseTo(0.41, 10);

    // opencode adds its current tables in place, with a newer session of the folder that holds
    // ses_current's rows of current.sql (0.30 and 0.14): the next refresh links it
    const current = opencodeDatabase(tempHome(), 'current');
    execFileSync('sqlite3', [
      database,
      `ATTACH ${sqlText(current)} AS c; ` +
        "CREATE TABLE session_v2 AS SELECT * FROM c.session_v2 WHERE id = 'ses_current'; " +
        "UPDATE session_v2 SET id = 'ses_new', directory = '/work/demo', time_updated = 1790000600000; " +
        "CREATE TABLE session_message AS SELECT * FROM c.session_message WHERE session_id = 'ses_current'; " +
        "UPDATE session_message SET session_id = 'ses_new';",
    ]);
    const upgraded = await refresh(now + 3000);
    expect([upgraded.path, upgraded.schema]).toEqual(['ses_new', 1]);
    expect(upgraded.costUsd).toBeCloseTo(0.44, 10);
    // both tables are kept: no lookup at the next refresh
    expect((await refresh(now + 6000)).schema).toBe(0);

    // opencode then drops its legacy tables: the kept lookup fails once, and that refresh reads
    // n/a; the next looks the tables up again and reads the session from the current ones
    execFileSync('sqlite3', [database, 'DROP TABLE session;']);
    expect(await refresh(now + 9000)).toEqual({ path: null, costUsd: null, schema: 0 });
    const dropped = await refresh(now + 12000);
    expect([dropped.path, dropped.schema]).toEqual(['ses_new', 1]);
    expect(dropped.costUsd).toBeCloseTo(0.44, 10);
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
