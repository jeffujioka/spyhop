// The catch-up on every Orca host: besides this computer's, it reads the harness sessions of each
// SSH host and paired server Orca lists, whether or not an Orca agent links to them. A test has
// no other host, so it stands in for `orca` and `ssh` only (test/helpers/stand-ins.ts): `orca host
// list` lists the SSH host `starfish-bs`, and `ssh starfish-bs` runs its command here under that
// host's own home folder, or fails as an unreachable host does. The worker, the store and every
// other program are the real ones.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { RANGE_REFRESH_MS } from '../../src/core/refresh.js';
import { run, type Run } from '../../src/exec.ts';
import { createCatchUp } from '../../src/history/catch-up.ts';
import { openStore, type Store } from '../../src/history/store.ts';
import { spendTab } from '../../src/live/spend.ts';
import { historyHosts, listHosts } from '../../src/hosts.ts';
import type { RangeAnswer } from '../../src/protocol.ts';
import { ompSessionDir } from '../helpers/agent-cards.ts';
import { setEnv, useTempHome } from '../helpers/env.ts';
import { tempHome } from '../helpers/files.ts';
import { caughtUp, rangeOf, storeOf } from '../helpers/history.ts';
import { mountOn, ompSession, spent } from '../helpers/live.ts';
import { figure, listOf, parts, text } from '../helpers/markup.ts';
import { environmentListOf, hostListOf, LOCAL_HOST } from '../helpers/orca-answers.ts';
import { withCopilotPrices } from '../helpers/prices.ts';
import { readOnlyLine } from '../helpers/read-only.ts';
import { standIns } from '../helpers/stand-ins.ts';

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

// `orca host list` and `orca environment list` with the SSH host `starfish-bs` the only other
// Orca host.
const STARFISH_LISTS = {
  'host list --json': hostListOf(LOCAL_HOST, { kind: 'ssh', id: 'starfish-bs', name: 'starfish-bs', selector: '--host ssh:starfish-bs', connected: true }),
  'environment list --json': environmentListOf(),
};

const ORIGIN = 'git@github.com:jeffujioka/spyhop.git';

// 2026-11-28 15:00 UTC, and epoch ms of 12:00 UTC on 27 November.
const CLOCK = Date.parse('2026-11-28T15:00:00.000Z');
const NOV_27 = Date.parse('2026-11-27T12:00:00.000Z');

// The folder `path` as a git repository with the origin ORIGIN.
function withOrigin(path: string) {
  execFileSync('git', ['init', '-q'], { cwd: path });
  execFileSync('git', ['remote', 'add', 'origin', ORIGIN], { cwd: path });
}

// An omp model call on 27 November through Copilot on `claude-opus-5.5` of `usd`: its output
// tokens, which COPILOT_OPUS prices at 2,500 credits (0.025 USD) per 1,000.
const copilotCall = (usd: number) => ({ at: NOV_27, provider: 'github-copilot', model: 'claude-opus-5.5', output: usd * 40_000, cost: usd });
const COPILOT_OPUS = { 'claude-opus-5.5': { input: 500, cachedInput: 50, cacheWrite: 625, output: 2500, tiers: [] } };

// An omp session on 27 November in a folder of origin ORIGIN on this computer whose Copilot call
// on `claude-opus-5.5` cost 1.00 USD and one on starfish-bs that cost 2.00 USD, the worker's Spend
// tab of Week once its first catch-up has read them, the home and the stand-ins' calls.
async function oneOriginOnTwoHosts() {
  withCopilotPrices(COPILOT_OPUS);
  const remoteHome = tempHome();
  let home = '';
  const range = await rangeOf([], {
    tab: 'spend',
    range: 'week',
    now: CLOCK,
    homes: { 'starfish-bs': remoteHome },
    orca: STARFISH_LISTS,
    prepare: (at) => {
      home = at;
      const local = join(home, 'projects/spyhop');
      ompSession(home, local, { title: 'spyhop', calls: [copilotCall(1)] });
      withOrigin(local);
      const remote = join(remoteHome, 'spyhop');
      ompSession(remoteHome, remote, { title: 'spyhop', calls: [copilotCall(2)] });
      withOrigin(remote);
    },
  });
  return { ...range, home };
}

// A catch-up of a new temporary home and of starfish-bs, whose home is `remoteHome`, through
// `exec` (the real runner when not given), with the real store; the stand-ins' calls.
async function catchUpOf(remoteHome: string, exec: Run = run) {
  setEnv('TZ', 'UTC');
  const home = useTempHome();
  const calls = standIns({ homes: { 'starfish-bs': remoteHome }, orca: STARFISH_LISTS });
  store = await openStore(home);
  const catchUp = createCatchUp({ run: exec, store, home, log: () => {}, hosts: async () => historyHosts(await listHosts(run)) });
  return { home, calls, catchUp };
}

test('Session no Orca agent links to', async () => {
  const remoteHome = tempHome();
  const { html } = await rangeOf([], {
    tab: 'spend',
    range: 'day',
    homes: { 'starfish-bs': remoteHome },
    orca: STARFISH_LISTS,
    prepare: () => ompSession(remoteHome, join(remoteHome, 'api'), { title: 'api', calls: [spent(1)] }),
  });

  assert.equal(figure(html, 'cost'), '$1.00');
});

test('One origin on two Orca hosts', async () => {
  const { html, calls } = await oneOriginOnTwoHosts();

  assert.deepEqual(listOf(html, 'repo'), [`${ORIGIN} $3.00`]);
  assert.ok(calls.ssh().length > 0);
  assert.deepEqual(calls.ssh().filter((args) => args[0] !== 'starfish-bs' || !readOnlyLine(args.at(-1)!)), []);
});

test('One repo on two Orca hosts', async () => {
  const { home, html } = await oneOriginOnTwoHosts();

  const db = storeOf(home);
  const lines = db.prepare("SELECT host, repo, harness, model, cost FROM daily_lines WHERE day = '2026-11-27' ORDER BY host").all();
  db.close();
  const model = 'github-copilot/claude-opus-5.5';
  assert.deepEqual(
    lines.map((line) => ({ ...line })),
    [
      { host: 'local', repo: ORIGIN, harness: 'omp', model, cost: 1 },
      { host: 'ssh:starfish-bs', repo: ORIGIN, harness: 'omp', model, cost: 2 },
    ],
  );
  assert.deepEqual(listOf(html, 'repo'), [`${ORIGIN} $3.00`]);
});

test('Appended bytes only', async () => {
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'api');
  ompSession(remoteHome, folder, { title: 'api', calls: [spent(1)] });
  const { home, calls, catchUp } = await catchUpOf(remoteHome);
  await catchUp.run();
  const dir = ompSessionDir(remoteHome, folder);
  const file = join(dir, '2026-11-25T11-58-00-000Z_s1.jsonl');
  const session = `ssh:starfish-bs\0omp\0${file}`;
  const db = storeOf(home);
  const costOf = () => Number(db.prepare('SELECT SUM(cost) AS cost FROM lines WHERE session = ?').get(session)!.cost);
  const before = costOf();
  const { pos } = db.prepare("SELECT pos FROM files WHERE host = 'ssh:starfish-bs' AND path = ?").get(file) as { pos: number };
  const mark = calls.ssh().length;

  // the same session, which has since logged a call of 0.10 USD
  ompSession(remoteHome, folder, { title: 'api', calls: [spent(1), spent(0.1, Date.now())] });
  await catchUp.run();

  const reads = calls
    .ssh()
    .slice(mark)
    .map((args) => args.at(-1)!)
    .filter((line) => line.includes(file));
  assert.ok(reads.includes(`'tail' '-c' '+${pos}' '--' '${file}'`), JSON.stringify(reads));
  assert.deepEqual(reads.filter((line) => line.startsWith("'dd'")), []);
  assert.ok(Math.abs(costOf() - before - 0.1) < 1e-9, `${before} -> ${costOf()}`);
  db.close();
  assert.deepEqual(calls.ssh().filter((args) => args[0] !== 'starfish-bs' || !readOnlyLine(args.at(-1)!)), []);
});

test("a host's programs run one at a time", async () => {
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'spyhop');
  ompSession(remoteHome, folder, { title: 'spyhop', calls: [spent(1)] });
  withOrigin(folder);
  // the most programs that ran on starfish-bs at once
  let running = 0;
  let most = 0;
  const counting: Run = async (command, args, options) => {
    if (options?.on !== 'starfish-bs') return run(command, args, options);
    running += 1;
    most = Math.max(most, running);
    try {
      return await run(command, args, options);
    } finally {
      running -= 1;
    }
  };
  const { catchUp } = await catchUpOf(remoteHome, counting);

  await catchUp.run();

  assert.equal(most, 1);
});

test('a host that drops while its repo is asked keeps no repo of it', async () => {
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'spyhop');
  ompSession(remoteHome, folder, { title: 'spyhop', calls: [spent(1)] });
  withOrigin(folder);
  // ssh to starfish-bs fails from its first `git` on, while `dropped`
  let dropped = true;
  const dropping: Run = (command, args, options) =>
    dropped && options?.on === 'starfish-bs' && command === 'git' ? Promise.resolve({ code: 255, stdout: '', stderr: 'Connection closed' }) : run(command, args, options);
  const { home, catchUp } = await catchUpOf(remoteHome, dropping);
  await catchUp.run();
  assert.deepEqual(catchUp.notRead(), ['starfish-bs']);

  dropped = false;
  await catchUp.run();

  const db = storeOf(home);
  const repos = db.prepare("SELECT DISTINCT repo FROM daily_lines WHERE host = 'ssh:starfish-bs'").all();
  db.close();
  assert.deepEqual(
    repos.map(({ repo }) => repo),
    [ORIGIN],
  );
});

test('Host that cannot be reached', async () => {
  const remoteHome = tempHome();
  const { home, mounted } = await mountOn([], {
    homes: { 'starfish-bs': remoteHome },
    orca: STARFISH_LISTS,
    prepare: () => ompSession(remoteHome, join(remoteHome, 'api'), { title: 'api', calls: [spent(2)] }),
  });
  await caughtUp(home);
  const down = standIns({ homes: {}, orca: STARFISH_LISTS });

  mock.timers.tick(RANGE_REFRESH_MS);
  const answer = (await mounted.request('spyhop.range', { request: 1, tab: 'spend', range: 'week' })) as RangeAnswer;

  const html = spendTab(answer);
  assert.deepEqual(answer.notRead, ['starfish-bs']);
  assert.match(text(parts(html, 'data-part', 'not-read')[0] ?? ''), /starfish-bs/);
  assert.equal(figure(html, 'cost'), '$2.00');
  const mark = down.ssh().length;
  mock.timers.tick(RANGE_REFRESH_MS);
  await mounted.request('spyhop.range', { request: 2, tab: 'spend', range: 'week' });
  assert.ok(down.ssh().slice(mark).some(([alias]) => alias === 'starfish-bs'));
});
