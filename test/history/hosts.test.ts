// The catch-up on every Orca host: besides this computer's, it reads the harness sessions of each
// SSH host and paired server Orca lists, whether or not an Orca agent links to them. A test has
// no other host, so it stands in for `orca` and `ssh` only (test/helpers/stand-ins.ts): `orca host
// list` lists the SSH host `starfish-bs`, and `ssh starfish-bs` runs its command here under that
// host's own home folder, or fails as an unreachable host does. The worker, the store and every
// other program are the real ones.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { type } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { RANGE_REFRESH_MS } from '../../src/core/refresh.js';
import { run, type Run, type RunBytes, runBytes, type RunOptions } from '../../src/exec.ts';
import { createCatchUp } from '../../src/history/catch-up.ts';
import { openStore, type Store } from '../../src/history/store.ts';
import { spendTab } from '../../src/live/spend.ts';
import { historyHosts, listHosts, machineIdIn, machineOf } from '../../src/hosts.ts';
import type { RangeAnswer } from '../../src/protocol.ts';
import { ompSessionDir } from '../helpers/agent-cards.ts';
import { setEnv, useTempHome } from '../helpers/env.ts';
import { tempHome } from '../helpers/files.ts';
import { caughtUp, rangeOf, storeOf } from '../helpers/history.ts';
import { mountOn, ompSession, spent } from '../helpers/live.ts';
import { figure, listOf, parts, text } from '../helpers/markup.ts';
import { DEVBOX, DEVBOX_HOST, environmentListOf, JEFF_LISTS, JEFF_SERVER_ENVIRONMENTS, JEFF_TARGET, LOCAL_HOST, hostListOf, STARFISH_LISTS } from '../helpers/orca-answers.ts';
import { withCopilotPrices } from '../helpers/prices.ts';
import { readOnlyLine, ZSTD_PIPE } from '../helpers/read-only.ts';
import { machineKeyOf, standIns } from '../helpers/stand-ins.ts';

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

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
  return { ...range, home, remoteHome };
}

// A catch-up of a new temporary home and of starfish-bs, whose home is `remoteHome`, through
// `exec` and `bytes` (the real runners when not given), with the real store, the `ssh` stand-in
// failing each command on starfish-bs that holds a word of `failing`; the stand-ins' calls.
async function catchUpOf(remoteHome: string, { exec = run, bytes = runBytes, failing = [] }: { exec?: Run; bytes?: RunBytes; failing?: string[] } = {}) {
  setEnv('TZ', 'UTC');
  const home = useTempHome();
  const calls = standIns({ homes: { 'starfish-bs': remoteHome }, orca: STARFISH_LISTS, failing: failing.map((word) => `ssh starfish-bs ${word}`) });
  store = await openStore(home);
  const catchUp = createCatchUp({ run: exec, runBytes: bytes, store, home, log: () => {}, hosts: async () => historyHosts(await listHosts(run)), aliasOf: async () => null });
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
  const { home, remoteHome, html } = await oneOriginOnTwoHosts();

  const db = storeOf(home);
  const lines = db.prepare("SELECT host, repo, harness, model, cost FROM daily_lines WHERE day = '2026-11-27' ORDER BY host").all();
  db.close();
  const model = 'github-copilot/claude-opus-5.5';
  assert.deepEqual(
    lines.map((line) => ({ ...line })),
    [
      { host: 'local', repo: ORIGIN, harness: 'omp', model, cost: 1 },
      { host: machineKeyOf(remoteHome), repo: ORIGIN, harness: 'omp', model, cost: 2 },
    ],
  );
  assert.deepEqual(listOf(html, 'repo'), [`${ORIGIN} $3.00`]);
});

// The SSH target `jeff` and the paired server `jeff-server` deployed over it, as this Mac's Orca
// lists them: both reached as the ssh alias `jeff`, so one home.
const JEFF_OVER_SSH = {
  'host list --json': hostListOf(LOCAL_HOST, { kind: 'ssh', name: 'jeff', id: JEFF_TARGET, selector: `--host ssh:${JEFF_TARGET}`, connected: true }),
  'environment list --json': JEFF_SERVER_ENVIRONMENTS,
};

test('a paired server deployed over a listed SSH host is read once', async () => {
  const remoteHome = tempHome();
  let home = '';
  const { html } = await rangeOf([], {
    tab: 'spend',
    range: 'day',
    homes: { jeff: remoteHome },
    orca: JEFF_OVER_SSH,
    prepare: (at) => {
      home = at;
      ompSession(remoteHome, join(remoteHome, 'api'), { title: 'api', calls: [spent(1)] });
    },
  });

  const db = storeOf(home);
  const hosts = db.prepare("SELECT DISTINCT host FROM files WHERE host != 'local'").all();
  db.close();
  assert.deepEqual(
    hosts.map(({ host }) => host),
    [machineKeyOf(remoteHome)],
  );
  assert.equal(figure(html, 'cost'), '$1.00');
});

test('a paired server whose deployment target is not listed is kept by its machine', async () => {
  const remoteHome = tempHome();
  let home = '';
  const { html } = await rangeOf([], {
    tab: 'spend',
    range: 'day',
    homes: { jeff: remoteHome },
    orca: JEFF_LISTS,
    prepare: (at) => {
      home = at;
      ompSession(remoteHome, join(remoteHome, 'api'), { title: 'api', calls: [spent(1)] });
    },
  });

  const db = storeOf(home);
  const hosts = db.prepare("SELECT DISTINCT host FROM files WHERE host != 'local'").all();
  db.close();
  assert.deepEqual(
    hosts.map(({ host }) => host),
    [machineKeyOf(remoteHome)],
  );
  assert.equal(figure(html, 'cost'), '$1.00');
});

// The two lists when the SSH target `devbox` has the Orca id `id`.
const devboxAs = (id: string) => ({
  'host list --json': hostListOf(LOCAL_HOST, { ...DEVBOX_HOST, id, selector: `--host ssh:${id}` }),
  'environment list --json': environmentListOf(),
});

test('a target re-added in Orca is read once', async () => {
  const remoteHome = tempHome();
  const { home, mounted } = await mountOn([], {
    homes: { devbox: remoteHome },
    orca: devboxAs(DEVBOX),
    prepare: () => ompSession(remoteHome, join(remoteHome, 'api'), { title: 'api', calls: [spent(1)] }),
  });
  await caughtUp(home);
  // devbox removed and added again: Orca lists the same alias under a new id
  const readd = standIns({ homes: { devbox: remoteHome }, orca: devboxAs('ssh-1795031810694-n3w1d') });

  // the range asked once a range refresh has passed: a catch-up runs before it answers
  mock.timers.tick(RANGE_REFRESH_MS);
  const answer = (await mounted.request('spyhop.range', { request: 1, tab: 'spend', range: 'day' })) as RangeAnswer;
  await caughtUp(home, 2);

  assert.ok(readd.ssh().some(([alias]) => alias === 'devbox'));
  assert.deepEqual(readd.ssh().filter((args) => args.at(-1)!.includes("'dd'")), []);
  const db = storeOf(home);
  const hosts = db.prepare("SELECT DISTINCT host FROM files WHERE host != 'local'").all();
  db.close();
  assert.deepEqual(
    hosts.map(({ host }) => host),
    [machineKeyOf(remoteHome)],
  );
  assert.equal(figure(spendTab(answer), 'cost'), '$1.00');
  assert.deepEqual(answer.notRead, []);
});

// The two lists when the SSH hosts `aliases`, each Orca's id its alias, are the only other Orca
// hosts.
const sshLists = (...aliases: string[]) => ({
  'host list --json': hostListOf(LOCAL_HOST, ...aliases.map((alias) => ({ kind: 'ssh', id: alias, name: alias, selector: `--host ssh:${alias}`, connected: true }))),
  'environment list --json': environmentListOf(),
});

test('two aliases of one machine are read once', async () => {
  const remoteHome = tempHome();
  let home = '';
  // `bs` and `starfish-bs` reach one machine, whose node name is `bs`
  const { answer, html, calls } = await rangeOf([], {
    tab: 'spend',
    range: 'day',
    homes: { bs: remoteHome, 'starfish-bs': remoteHome },
    orca: sshLists('bs', 'starfish-bs'),
    prepare: (at) => {
      home = at;
      ompSession(remoteHome, join(remoteHome, 'api'), { title: 'api', calls: [spent(1)] });
    },
  });

  const db = storeOf(home);
  const hosts = db.prepare("SELECT DISTINCT host FROM files WHERE host != 'local'").all();
  db.close();
  assert.deepEqual(
    hosts.map(({ host }) => host),
    [machineKeyOf(remoteHome)],
  );
  assert.equal(figure(html, 'cost'), '$1.00');
  assert.deepEqual(answer.notRead, []);
  assert.deepEqual(calls.ssh().filter((args) => args[0] === 'starfish-bs' && args.at(-1)!.includes("'find'")), []);
});

test('an alias that reaches this computer is not read', async () => {
  // `localhost` reaches this computer: its node name and its home are this computer's
  const homes: Record<string, string> = {};
  const { answer, html, calls } = await rangeOf([], {
    tab: 'spend',
    range: 'day',
    homes,
    orca: sshLists('localhost'),
    prepare: (home) => {
      homes.localhost = home;
      ompSession(home, join(home, 'api'), { title: 'api', calls: [spent(1)] });
    },
  });

  assert.equal(figure(html, 'cost'), '$1.00');
  assert.deepEqual(answer.notRead, []);
  // only its place asked
  assert.deepEqual(calls.ssh().map((args) => args.at(-1)).sort(), ["'ioreg' '-rd1' '-c' 'IOPlatformExpertDevice'", "'printenv' 'HOME'", "'uname' '-sn'"]);
});

test('a machine listed under another alias in a later run is read once', async () => {
  const remoteHome = tempHome();
  const { home, mounted } = await mountOn([], {
    homes: { bs: remoteHome },
    orca: sshLists('bs'),
    prepare: () => ompSession(remoteHome, join(remoteHome, 'api'), { title: 'api', calls: [spent(1)] }),
  });
  await caughtUp(home);
  // Orca now lists the same machine as `starfish-bs` only
  const relisted = standIns({ homes: { 'starfish-bs': remoteHome }, orca: sshLists('starfish-bs') });

  mock.timers.tick(RANGE_REFRESH_MS);
  const answer = (await mounted.request('spyhop.range', { request: 1, tab: 'spend', range: 'day' })) as RangeAnswer;
  await caughtUp(home, 2);

  assert.ok(relisted.ssh().some(([alias]) => alias === 'starfish-bs'));
  assert.deepEqual(relisted.ssh().filter((args) => args.at(-1)!.includes("'dd'")), []);
  const db = storeOf(home);
  const hosts = db.prepare("SELECT DISTINCT host FROM files WHERE host != 'local'").all();
  db.close();
  assert.deepEqual(
    hosts.map(({ host }) => host),
    [machineKeyOf(remoteHome)],
  );
  assert.equal(figure(spendTab(answer), 'cost'), '$1.00');
  assert.deepEqual(answer.notRead, []);
});

test("a machine's id in its id program's answer", () => {
  const ioreg = (line: string) => `+-o J316sAP  <class IOPlatformExpertDevice>\n  {\n    "IOPlatformSerialNumber" = "C02X"\n${line}  }\n`;
  assert.equal(machineIdIn('Darwin', ioreg('    "IOPlatformUUID" = "4C4C4544-0042-3510"\n')), '4C4C4544-0042-3510');
  assert.equal(machineIdIn('Darwin', ioreg('')), '');
  assert.equal(machineIdIn('Darwin', ioreg('    "IOPlatformUUID" = ""\n')), '');
  assert.equal(machineIdIn('Linux', 'b08dfa6083e7567a1921a715000001fb \n'), 'b08dfa6083e7567a1921a715000001fb');
  assert.equal(machineIdIn('Linux', '\n'), '');
});

test("a machine's identity is its id, else its node name, never empty", { skip: type() !== 'Darwin' }, async () => {
  assert.match(await machineOf(run, 'Darwin', 'node-a'), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // a Mac has no /etc/machine-id: `cat` answers, exiting 1
  assert.equal(await machineOf(run, 'Linux', 'node-a'), 'node-a');
  await assert.rejects(machineOf(run, 'Linux', ''), /machine unknown/);
});

// The word of the command line that asks a stand-in machine its id.
const ID_WORD = type() === 'Darwin' ? "'ioreg'" : "'/etc/machine-id'";

test('a host whose id is not answered is not read', async () => {
  const remoteHome = tempHome();
  ompSession(remoteHome, join(remoteHome, 'api'), { title: 'api', calls: [spent(1)] });
  // once `lost`, the ask of starfish-bs's id rejects, as a run past its timeout does
  let lost = false;
  const exec: Run = async (command, args, options) => {
    if (lost && options?.on === 'starfish-bs' && (command === 'ioreg' || args.includes('/etc/machine-id'))) throw new Error('timed out');
    return run(command, args, options);
  };
  const { home, catchUp } = await catchUpOf(remoteHome, { exec });
  await catchUp.run();
  assert.deepEqual(catchUp.notRead(), []);

  lost = true;
  await catchUp.run();
  assert.deepEqual(catchUp.notRead(), ['starfish-bs']);

  // ssh drops while the id is asked
  lost = false;
  standIns({ homes: { 'starfish-bs': remoteHome }, orca: STARFISH_LISTS, failing: [`ssh starfish-bs ${ID_WORD}`] });
  await catchUp.run();
  assert.deepEqual(catchUp.notRead(), ['starfish-bs']);

  const db = storeOf(home);
  const hosts = db.prepare("SELECT DISTINCT host FROM files WHERE host != 'local'").all();
  db.close();
  assert.deepEqual(
    hosts.map(({ host }) => host),
    [machineKeyOf(remoteHome)],
  );
});

test("no other host is read while this computer's id is not answered", async () => {
  const remoteHome = tempHome();
  ompSession(remoteHome, join(remoteHome, 'api'), { title: 'api', calls: [spent(1)] });
  // while `lost`, the ask of this computer's id rejects, as a run past its timeout does
  let lost = true;
  const exec: Run = async (command, args, options) => {
    if (lost && options?.on === undefined && (command === 'ioreg' || args.includes('/etc/machine-id'))) throw new Error('timed out');
    return run(command, args, options);
  };
  const { home, catchUp } = await catchUpOf(remoteHome, { exec });
  const remoteHosts = () => {
    const db = storeOf(home);
    const hosts = db.prepare("SELECT DISTINCT host FROM files WHERE host != 'local'").all();
    db.close();
    return hosts.map(({ host }) => host);
  };

  await catchUp.run();
  assert.deepEqual(catchUp.notRead(), ['starfish-bs']);
  assert.deepEqual(remoteHosts(), []);

  // the failed ask was not kept: the next run asks again, and reads the hosts
  lost = false;
  await catchUp.run();
  assert.deepEqual(catchUp.notRead(), []);
  assert.deepEqual(remoteHosts(), [machineKeyOf(remoteHome)]);
});

test('Appended bytes only', async () => {
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'api');
  ompSession(remoteHome, folder, { title: 'api', calls: [spent(1)] });
  const { home, calls, catchUp } = await catchUpOf(remoteHome);
  await catchUp.run();
  const dir = ompSessionDir(remoteHome, folder);
  const file = join(dir, '2026-11-25T11-58-00-000Z_s1.jsonl');
  const session = `${machineKeyOf(remoteHome)}\0omp\0${file}`;
  const db = storeOf(home);
  const costOf = () => Number(db.prepare('SELECT SUM(cost) AS cost FROM lines WHERE session = ?').get(session)!.cost);
  const before = costOf();
  const { pos } = db.prepare('SELECT pos FROM files WHERE host = ? AND path = ?').get(machineKeyOf(remoteHome), file) as { pos: number };
  const mark = calls.ssh().length;

  // the same session, which has since logged a call of 0.10 USD
  ompSession(remoteHome, folder, { title: 'api', calls: [spent(1), spent(0.1, Date.now())] });
  await catchUp.run();

  const reads = calls
    .ssh()
    .slice(mark)
    .map((args) => args.at(-1)!)
    .filter((line) => line.includes(file));
  // the line itself, or that line under `zstd` (test/history/zstd.test.ts)
  assert.ok(reads.some((line) => line.endsWith(`'tail' '-c' '+${pos}' '--' '${file}'`)), JSON.stringify(reads));
  assert.deepEqual(reads.filter((line) => line.includes("'dd'")), []);
  assert.ok(Math.abs(costOf() - before - 0.1) < 1e-9, `${before} -> ${costOf()}`);
  db.close();
  assert.deepEqual(calls.ssh().filter((args) => args[0] !== 'starfish-bs' || !readOnlyLine(args.at(-1)!)), []);
});

test("a host's programs run one at a time", async () => {
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'spyhop');
  ompSession(remoteHome, folder, { title: 'spyhop', calls: [spent(1)] });
  withOrigin(folder);
  // the most programs that ran on starfish-bs at once, and each program run there, the one a
  // compressed line wraps included
  let running = 0;
  let most = 0;
  const programs: string[] = [];
  const counting =
    <Result>(runner: (command: string, args: string[], options?: RunOptions) => Promise<Result>) =>
    async (command: string, args: string[], options?: RunOptions) => {
      if (options?.on !== 'starfish-bs') return runner(command, args, options);
      programs.push(command === 'sh' ? args[3] : command);
      running += 1;
      most = Math.max(most, running);
      try {
        return await runner(command, args, options);
      } finally {
        running -= 1;
      }
    };
  const { catchUp } = await catchUpOf(remoteHome, { exec: counting(run), bytes: counting(runBytes) });

  await catchUp.run();

  assert.equal(most, 1);
  assert.ok(['find', 'dd', 'git'].every((program) => programs.includes(program)), JSON.stringify(programs));
});

test('a host that drops while its repo is asked keeps no repo of it', async () => {
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'spyhop');
  ompSession(remoteHome, folder, { title: 'spyhop', calls: [spent(1)] });
  withOrigin(folder);
  // ssh to starfish-bs fails on each `git`
  const { home, catchUp } = await catchUpOf(remoteHome, { failing: ["'git'"] });
  await catchUp.run();
  assert.deepEqual(catchUp.notRead(), ['starfish-bs']);

  // starfish-bs reached again
  standIns({ homes: { 'starfish-bs': remoteHome }, orca: STARFISH_LISTS });
  await catchUp.run();

  const db = storeOf(home);
  const repos = db.prepare('SELECT DISTINCT repo FROM daily_lines WHERE host = ?').all(machineKeyOf(remoteHome));
  db.close();
  assert.deepEqual(
    repos.map(({ repo }) => repo),
    [ORIGIN],
  );
});

test('a host that drops while a file is read compressed is not read', async () => {
  const remoteHome = tempHome();
  ompSession(remoteHome, join(remoteHome, 'api'), { title: 'api', calls: [spent(1)] });
  // ssh to starfish-bs fails on each compressed read of a file's bytes
  const { calls, catchUp } = await catchUpOf(remoteHome, { failing: ["'sh' 'dd'", "'sh' 'tail'"] });

  await catchUp.run();

  assert.deepEqual(catchUp.notRead(), ['starfish-bs']);
  assert.ok(calls.ssh().some((args) => args.at(-1)!.startsWith(`${ZSTD_PIPE} 'dd'`)));
});

test('a listing that fails through zstd leaves the run unended', async () => {
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'api');
  ompSession(remoteHome, folder, { title: 'api', calls: [spent(1)] });
  // a folder of the sessions folder that `find` cannot enter: it exits 1, the others listed
  const locked = join(dirname(ompSessionDir(remoteHome, folder)), 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  const { home, calls, catchUp } = await catchUpOf(remoteHome);

  try {
    await catchUp.run();
  } finally {
    chmodSync(locked, 0o700);
  }

  assert.ok(calls.ssh().some((args) => args.at(-1)!.includes("'find'") && args.at(-1)!.includes('zstd')));
  assert.deepEqual(catchUp.notRead(), []);
  const db = storeOf(home);
  const ended = db.prepare("SELECT value FROM meta WHERE key = 'catch-ups'").get();
  db.close();
  assert.equal(ended, undefined);
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
