// The catch-up reads another Orca host's session files compressed with `zstd` when the host has
// it, raw otherwise. A test has no other host, so it stands in for `orca` and `ssh` only
// (test/helpers/stand-ins.ts): `ssh <alias>` runs its command here under that host's own home
// folder, with this Mac's `zstd`, or with none for a host the test names. The worker, the store,
// `zstd` and every other program are the real ones.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { run, runBytes } from '../../src/exec.ts';
import { createCatchUp } from '../../src/history/catch-up.ts';
import { openStore } from '../../src/history/store.ts';
import { historyHosts, listHosts } from '../../src/hosts.ts';
import { opencodeSession } from '../helpers/agent-cards.ts';
import { setEnv, useTempHome } from '../helpers/env.ts';
import { tempHome } from '../helpers/files.ts';
import { rangeOf, storeOf } from '../helpers/history.ts';
import { ompSession, spent } from '../helpers/live.ts';
import { DEVBOX_LISTS, environmentListOf, hostListOf, STARFISH_LISTS } from '../helpers/orca-answers.ts';
import { figure } from '../helpers/markup.ts';
import { readOnlyLine, ZSTD_PIPE } from '../helpers/read-only.ts';
import { standIns } from '../helpers/stand-ins.ts';

// The Spend tab of Day once the first catch-up has read an omp session of 1.00 USD today on the
// SSH host `alias`, the only other Orca host, listed by `lists`, and the commands run on it.
async function oneDollarOn(alias: string, lists: Record<string, string>, noZstd: string[] = []) {
  const remoteHome = tempHome();
  const { html, calls } = await rangeOf([], {
    tab: 'spend',
    range: 'day',
    homes: { [alias]: remoteHome },
    orca: lists,
    noZstd,
    prepare: () => ompSession(remoteHome, join(remoteHome, 'api'), { title: 'api', calls: [spent(1)] }),
  });
  return { html, lines: calls.ssh().map((args) => ({ alias: args[0], line: args.at(-1)! })) };
}

test('Host with zstd', async () => {
  assert.doesNotThrow(() => execFileSync('zstd', ['-V'], { stdio: 'ignore' }), 'this Mac has no zstd');

  const { html, lines } = await oneDollarOn('devbox', DEVBOX_LISTS);
  // the listings and the reads of the session file
  const reads = lines.filter(({ line }) => line.includes('.jsonl')).map(({ line }) => line);
  assert.ok(['find', 'dd'].every((program) => reads.some((line) => line.startsWith(`${ZSTD_PIPE} '${program}'`))), JSON.stringify(reads));
  assert.ok(reads.every((line) => line.startsWith(ZSTD_PIPE)), JSON.stringify(reads));
  assert.deepEqual(lines.filter(({ alias, line }) => alias !== 'devbox' || !readOnlyLine(line)), []);
  assert.equal(figure(html, 'cost'), '$1.00');
});

test('Host without zstd', async () => {
  const oldbox = { kind: 'ssh', name: 'oldbox', id: 'oldbox', selector: '--host ssh:oldbox', connected: true };
  const lists = { 'host list --json': hostListOf(oldbox), 'environment list --json': environmentListOf() };

  const { html, lines } = await oneDollarOn('oldbox', lists, ['oldbox']);

  const probe = lines.findIndex(({ line }) => line === "'zstd' '-V'");
  assert.ok(probe >= 0, JSON.stringify(lines));
  const after = lines.slice(probe + 1).map(({ line }) => line);
  assert.deepEqual(after.filter((line) => line.startsWith("'sh'")), []);
  assert.ok(after.some((line) => line.includes('.jsonl') && (line.startsWith("'dd'") || line.startsWith("'tail'"))), JSON.stringify(after));
  assert.equal(figure(html, 'cost'), '$1.00');
});

// A guard of the runner's output cap, no scenario of the spec: an answer `zstd` compresses
// within the cap but that is larger than it, which the host would be refused raw, is refused
// compressed too.
test('a compressed answer is no larger than a raw one could be', async () => {
  setEnv('TZ', 'UTC');
  const home = useTempHome();
  const remoteHome = tempHome();
  // 2,500 opencode calls of a model whose id is 4,000 characters: a page of rows over 10 MB
  const database = opencodeSession(remoteHome, join(remoteHome, 'web'), {
    provider: 'anthropic',
    model: 'm'.repeat(4000),
    calls: [{ uncached: 100, read: 0, write: 0, output: 50 }],
    cost: 0.2,
  });
  execFileSync('sqlite3', [
    database,
    "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 2499) INSERT INTO session_message SELECT 'w' || n, session_id, type, seq + n, time_created + n, time_updated + n, data FROM session_message, c WHERE id = 'w0'",
  ]);
  standIns({ homes: { 'starfish-bs': remoteHome }, orca: STARFISH_LISTS });
  const logs: string[] = [];
  const store = await openStore(home);
  const catchUp = createCatchUp({ run, runBytes, store, home, log: (message) => logs.push(message), hosts: async () => historyHosts(await listHosts(run)) });

  try {
    await catchUp.run();
  } finally {
    store.close();
  }

  const db = storeOf(home);
  const { n } = db.prepare("SELECT count(*) AS n FROM lines JOIN files ON files.id = lines.file WHERE host = 'machine:starfish-bs' AND harness = 'opencode'").get()!;
  db.close();
  assert.equal(Number(n), 0);
  assert.ok(logs.some((line) => line.includes("cannot read opencode's database")), JSON.stringify(logs));
});
