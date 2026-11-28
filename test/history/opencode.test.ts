// opencode's database in the history store: each catch-up reads every host's opencode database
// (~/.local/share/opencode/opencode.db) into the store, the first time whole, then again from the
// day OPENCODE_OPEN_DAYS before today, so that a call opencode updates in place is counted as it
// is now while it is that young, and a day older stays as it was read. The store, the runner and
// sqlite3 are the real ones, under a temporary home; another Orca host is the stand-in `ssh` of
// test/history/hosts.test.ts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { dayOf, midnightBefore } from '../../src/core/days.js';
import { historyRowsQuery, SCHEMA_QUERY, select, sessionsIn } from '../../src/core/providers/opencode-sources.js';
import { run, runBytes } from '../../src/exec.ts';
import { createCatchUp, OPENCODE_OPEN_DAYS } from '../../src/history/catch-up.ts';
import { openStore, type Store } from '../../src/history/store.ts';
import { opencodeDatabase, opencodeSession, sqlText } from '../helpers/agent-cards.ts';
import { setEnv, useTempHome } from '../helpers/env.ts';
import { tempHome } from '../helpers/files.ts';
import { rangeOf, storeOf } from '../helpers/history.ts';
import { claudeSession, ompSession, ompSubAgent, type OmpCall } from '../helpers/live.ts';
import { figure, listOf } from '../helpers/markup.ts';
import { STARFISH_LISTS } from '../helpers/orca-answers.ts';
import { withCopilotPrices } from '../helpers/prices.ts';

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

const DAY_MS = 24 * 60 * 60 * 1000;

// Rounded to the cent, against the sums' floating-point error.
const cents = (usd: number) => Math.round(usd * 100) / 100;

// One opencode call of 100 tokens sent fresh and 50 output.
const ONE_CALL = [{ uncached: 100, read: 0, write: 0, output: 50 }];

// A catch-up of a new temporary home in UTC, whose opencode database `write` makes, then another
// once `between` has changed it; the lines of opencode the store then holds of the day `day`
// (`session`, `repo`, `cost`, `tokens`, `calls`), and what the catch-ups logged.
async function twoCatchUps(write: (home: string) => void, between: (home: string) => void, day: string) {
  setEnv('TZ', 'UTC');
  const home = useTempHome();
  write(home);
  const logs: string[] = [];
  store = await openStore(home);
  const catchUp = createCatchUp({ run, runBytes, store, home, log: (message) => logs.push(message), hosts: async () => [] });
  await catchUp.run();
  between(home);
  await catchUp.run();
  const db = storeOf(home);
  const lines = db
    .prepare("SELECT session, repo, cost, tokens, calls FROM lines JOIN files ON files.id = lines.file WHERE harness = 'opencode' AND day = ? ORDER BY session, repo")
    .all(day)
    .map((line) => ({ ...line, cost: cents(Number(line.cost)) }));
  db.close();
  return { home, lines, logs };
}

// A call of opencode, of 0.20 USD, created at `last`, in the folder `web` under the home.
const callAt = (home: string, last: number, callCost = 0.2, update = false) =>
  opencodeSession(home, join(home, 'web'), { provider: 'anthropic', model: 'claude-opus-5.5', calls: ONE_CALL, cost: callCost, callCost, last, update });

// A call of opencode created `days` days ago, read by a catch-up at 0.20 USD, then updated in
// place by opencode to 0.80 USD and read by the next catch-up: the cost of its day in the store.
async function updatedCallOf(days: number) {
  const last = Date.now() - days * DAY_MS;
  const { lines } = await twoCatchUps(
    (home) => callAt(home, last),
    (home) => callAt(home, last, 0.8, true),
    dayOf(last),
  );
  return cents(lines.reduce((sum, { cost }) => sum + cost, 0));
}

test('Change within 10 days', async () => {
  assert.equal(await updatedCallOf(3), 0.8);
});

test('Change after 10 days', async () => {
  assert.equal(await updatedCallOf(12), 0.2);
});

// A guard of the days, no scenario of the spec: a call counts on the day it was created, the day
// a catch-up reads it again by, so one that runs across the midnight the catch-ups read again
// from keeps its cost.
test('an opencode call across the midnight read again from keeps its cost', async () => {
  setEnv('TZ', 'UTC');
  const created = midnightBefore(Date.now(), OPENCODE_OPEN_DAYS) - 10_000;
  const call = { uncached: 100, read: 0, write: 0, output: 50, took: 20_000 };
  const { lines } = await twoCatchUps(
    (home) => opencodeSession(home, join(home, 'web'), { provider: 'anthropic', model: 'claude-opus-5.5', calls: [call], cost: 0.2, callCost: 0.2, last: created }),
    () => {},
    dayOf(created),
  );
  assert.deepEqual(lines.map(({ cost, calls }) => ({ cost, calls })), [{ cost: 0.2, calls: 1 }]);
});

// A guard of the repos, no scenario of the spec: a session's folder keeps the repo git gave when
// it was first read, as a session file does, though its calls are read again: a worktree is
// often deleted once merged.
test("an opencode folder's repo is the one first read", async () => {
  const last = Date.now() - 3 * DAY_MS;
  const origin = 'git@github.com:jeffujioka/web.git';
  const { lines } = await twoCatchUps(
    (home) => {
      callAt(home, last);
      mkdirSync(join(home, 'web'));
      execFileSync('git', ['init', '-q'], { cwd: join(home, 'web') });
      execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: join(home, 'web') });
    },
    (home) => {
      rmSync(join(home, 'web', '.git'), { recursive: true });
      callAt(home, last, 0.8, true);
    },
    dayOf(last),
  );
  assert.deepEqual(lines.map(({ repo, cost }) => ({ repo, cost })), [{ repo: origin, cost: 0.8 }]);
});

// A guard of the sessions, no scenario of the spec: a sub-agent's calls count in its root
// session, in the repo of its own folder.
test("an opencode sub-agent's calls count in its root session", async () => {
  const last = Date.now() - 3 * DAY_MS;
  const { home, lines } = await twoCatchUps(
    (home) => {
      const database = callAt(home, last);
      const data = { time: { created: last }, model: { id: 'claude-opus-5.5', providerID: 'anthropic' }, cost: 0.3, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } };
      execFileSync('sqlite3', [
        database,
        `INSERT INTO session_v2 VALUES ('ses_child', 'prj', 'ses_window', 's', ${sqlText(join(home, 'child'))}, 't', '2.0.0', 0.3, NULL, NULL, ${last}, ${last}, NULL);` +
          `INSERT INTO session_v2 VALUES ('ses_grandchild', 'prj', 'ses_child', 's', ${sqlText(join(home, 'child'))}, 't', '2.0.0', 0.3, NULL, NULL, ${last}, ${last}, NULL);` +
          `INSERT INTO session_message VALUES ('k0', 'ses_child', 'assistant', 1, ${last}, ${last}, ${sqlText(JSON.stringify(data))});` +
          `INSERT INTO session_message VALUES ('g0', 'ses_grandchild', 'assistant', 1, ${last}, ${last}, ${sqlText(JSON.stringify(data))});`,
      ]);
    },
    () => {},
    dayOf(last),
  );
  const root = 'local\0opencode\0ses_window';
  assert.deepEqual(
    lines.map(({ session, repo, cost, calls }) => ({ session, repo, cost, calls })),
    [
      { session: root, repo: join(home, 'child'), cost: 0.6, calls: 2 },
      { session: root, repo: join(home, 'web'), cost: 0.2, calls: 1 },
    ],
  );
});

// A guard of the tokens, no scenario of the spec: a call counts the tokens the live reader
// counts of it (src/core/providers/opencode.js), none when one of its parts is not logged.
test('an opencode call without all its token parts counts no tokens, as live', async () => {
  const last = Date.now() - 3 * DAY_MS;
  const { lines } = await twoCatchUps(
    (home) => {
      const database = callAt(home, last);
      execFileSync('sqlite3', [database, "UPDATE session_message SET data = json_remove(data, '$.tokens.cache.write') WHERE session_id = 'ses_window'"]);
    },
    () => {},
    dayOf(last),
  );
  assert.deepEqual(lines.map(({ tokens, calls }) => ({ tokens, calls })), [{ tokens: 0, calls: 1 }]);
});

// opencode's database under `home`, a file of `text`.
function databaseFile(home: string, text: string) {
  mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
  writeFileSync(join(home, '.local/share/opencode/opencode.db'), text);
}

// A guard of the log, no scenario of the spec: a database there that sqlite3 cannot read is
// written to the log, once a catch-up.
test('an opencode database that cannot be read is logged', async () => {
  const { logs } = await twoCatchUps((home) => databaseFile(home, 'not a database'), () => {}, '');
  assert.equal(logs.filter((line) => line.includes('opencode.db')).length, 2, JSON.stringify(logs));
});

// A guard of the log, no scenario of the spec: a host without opencode's database logs nothing.
test('a host without an opencode database logs nothing', async () => {
  const { logs } = await twoCatchUps(() => {}, () => {}, '');
  assert.deepEqual(logs, []);
});

// A guard of historyRowsQuery, no scenario of the spec: read a page at a time, the rows of
// current.sql are those of one read, in the same order.
test("opencode's rows read a page at a time are those of one read", async () => {
  const database = opencodeDatabase(tempHome(), 'current');
  const sessions = sessionsIn((await select(run, database, SCHEMA_QUERY))!);
  const whole = (await select(run, database, historyRowsQuery(sessions, 0, null, 5000)))!;
  const paged = [];
  let page = (await select(run, database, historyRowsQuery(sessions, 0, null, 2)))!;
  while (page.length > 0) {
    paged.push(...page);
    const { created, id } = page.at(-1);
    page = (await select(run, database, historyRowsQuery(sessions, created, id, 2)))!;
  }
  assert.ok(whole.length > 4);
  assert.deepEqual(paged, whole);
});

// 2026-11-28 15:00 UTC, a week whose days hold 25 November, when the sessions below ran.
const CLOCK = Date.parse('2026-11-28T15:00:00.000Z');
const NOV_25 = Date.parse('2026-11-25T11:00:00.000Z');

// `count` omp calls of 0.025 USD and `output` tokens each, a second apart from `from`.
const ompCalls = (count: number, output: number, from: number): OmpCall[] => Array.from({ length: count }, (_, i) => ({ at: from + i * 1000, output, cost: 0.025 }));

test('Two harnesses on two Orca hosts', async () => {
  const remoteHome = tempHome();
  const { html } = await rangeOf([], {
    tab: 'spend',
    range: 'week',
    now: CLOCK,
    homes: { 'starfish-bs': remoteHome },
    orca: STARFISH_LISTS,
    prepare: (home) => {
      // 100 calls of the session and 20 of its sub-agent: 120 calls, 2,000,000 tokens, 3.00 USD
      const api = join(home, 'api');
      ompSession(home, api, { title: 'api', calls: ompCalls(100, 16_000, NOV_25) });
      ompSubAgent(home, api, 'Impl1', { calls: ompCalls(20, 20_000, NOV_25 + 200_000) });
      // 30 calls: 10 of 25,000 tokens and 20 of 12,500, 500,000 tokens, at 1.00 USD together
      const calls = Array.from({ length: 30 }, (_, i) => ({ uncached: 0, read: 0, write: 0, output: i < 10 ? 25_000 : 12_500 }));
      const database = opencodeSession(remoteHome, join(remoteHome, 'web'), { id: 'ses_web', provider: 'anthropic', model: 'claude-opus-5.5', calls, cost: 1, callCost: 1 / 30 });
      // its only session: those of current.sql are of ten folders more, each a `git` over `ssh`
      execFileSync('sqlite3', [database, "DELETE FROM session_v2 WHERE id <> 'ses_web'; DELETE FROM session;"]);
    },
  });

  assert.equal(figure(html, 'cost'), '$4.00');
  assert.equal(figure(html, 'tokens'), '2,500,000');
  assert.equal(figure(html, 'calls'), '150');
});

test('Models with their provider', async () => {
  withCopilotPrices({ 'claude-opus-5.5': { input: 500, cachedInput: 50, cacheWrite: 625, output: 2500, tiers: [] } });
  const { html } = await rangeOf([], {
    tab: 'spend',
    range: 'week',
    now: CLOCK,
    prepare: (home) => {
      ompSession(home, join(home, 'api'), { title: 'api', calls: [{ at: NOV_25, provider: 'github-copilot', model: 'claude-opus-5.5', output: 40_000, cost: 1 }] });
      opencodeSession(home, join(home, 'web'), { provider: 'anthropic', model: 'claude-opus-5.5', calls: ONE_CALL, cost: 2, callCost: 2 });
      claudeSession(home, join(home, 'cli'), { model: 'claude-opus-5-5', calls: [{ at: NOV_25, output: 1000 }], costStates: [{ at: NOV_25 + 1, models: { 'claude-opus-5-5': 3 } }] });
    },
  });

  assert.deepEqual(listOf(html, 'model').map((row) => row.replace(/ \$[\d.,]+$/, '')), ['claude-opus-5-5', 'anthropic/claude-opus-5.5', 'github-copilot/claude-opus-5.5']);
});
