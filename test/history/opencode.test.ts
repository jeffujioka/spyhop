// opencode's database in the history store: each catch-up reads every host's opencode database
// (~/.local/share/opencode/opencode.db) into the store, the first time whole, then again from the
// day OPENCODE_OPEN_DAYS before today, so that a call opencode updates in place is counted as it
// is now while it is that young, and a day older stays as it was read. The store, the runner and
// sqlite3 are the real ones, under a temporary home; another Orca host is the stand-in `ssh` of
// test/history/hosts.test.ts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { dayOf } from '../../src/core/days.js';
import { run, runBytes } from '../../src/exec.ts';
import { createCatchUp } from '../../src/history/catch-up.ts';
import { openStore, type Store } from '../../src/history/store.ts';
import { opencodeSession } from '../helpers/agent-cards.ts';
import { setEnv, useTempHome } from '../helpers/env.ts';
import { tempHome } from '../helpers/files.ts';
import { rangeOf, storeOf } from '../helpers/history.ts';
import { claudeSession, ompSession, ompSubAgent, type OmpCall } from '../helpers/live.ts';
import { figure, listOf } from '../helpers/markup.ts';
import { environmentListOf, hostListOf, LOCAL_HOST } from '../helpers/orca-answers.ts';
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

// A call of opencode created `days` days ago, read by a catch-up at 0.20 USD, then updated in
// place by opencode to 0.80 USD and read by the next catch-up: the cost of its day in the store.
async function updatedCallOf(days: number) {
  setEnv('TZ', 'UTC');
  const home = useTempHome();
  const folder = join(home, 'web');
  const last = Date.now() - days * DAY_MS;
  const call = { provider: 'anthropic', model: 'claude-opus-5.5', calls: ONE_CALL, cost: 0.2, last };
  opencodeSession(home, folder, { ...call, callCost: 0.2 });
  store = await openStore(home);
  const catchUp = createCatchUp({ run, runBytes, store, home, log: () => {}, hosts: async () => [] });
  await catchUp.run();
  opencodeSession(home, folder, { ...call, callCost: 0.8, update: true });
  await catchUp.run();
  const db = storeOf(home);
  const { cost } = db.prepare("SELECT SUM(cost) AS cost FROM daily_lines WHERE harness = 'opencode' AND day = ?").get(dayOf(last)) as { cost: number };
  db.close();
  return cents(cost);
}

test('Change within 10 days', async () => {
  assert.equal(await updatedCallOf(3), 0.8);
});

test('Change after 10 days', async () => {
  assert.equal(await updatedCallOf(12), 0.2);
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
    orca: {
      'host list --json': hostListOf(LOCAL_HOST, { kind: 'ssh', id: 'starfish-bs', name: 'starfish-bs', selector: '--host ssh:starfish-bs', connected: true }),
      'environment list --json': environmentListOf(),
    },
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
