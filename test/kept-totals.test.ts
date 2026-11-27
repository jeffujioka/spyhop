// The session reader's totals kept in the plugin's storage: a worker writes the totals of each
// session file it scanned, at most every 30 seconds, and a new worker starts from them, so a
// file scanned before is not scanned again from its start. The worker is the real one, on
// orca/testing's mock host with its own storage (test/helpers/orca-host.ts); a new worker
// "starts with that storage" on a mock host that holds what the first one's holds. The `orca`
// CLI and `ssh` are stood in for (test/helpers/stand-ins.ts): `ssh devbox` runs the real `tail`
// and `dd` here and logs them. Time is `node:test`'s mock clock. A card's tokens are no figure
// of the fleet answer, so the tokens of Claude Code's kept totals are read from a card builder
// made as the worker makes its own when it starts, from what the storage holds.
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { afterEach, assert, mountWorker, test, type MockHostOptions, type TestWorker } from 'orca/testing';
import { createAgentCards } from '../src/agent-cards.ts';
import { sessionDirSlug } from '../src/core/providers/claude-sources.js';
import { decodeScans, KEPT_VERSION, TAIL_BYTES } from '../src/core/refresh.js';
import { run } from '../src/exec.ts';
import type { FleetAnswer } from '../src/protocol.ts';
import * as workerModule from '../src/worker.ts';
import { claudeAssistant, claudeUsage } from './core/helpers/entries.ts';
import { NOW, agent, costOf, costTurn, ompSessionOf as ompSession, tokensOf } from './helpers/agent-cards.ts';
import { useTempHome } from './helpers/env.ts';
import { tempHome } from './helpers/files.ts';
import { DEVBOX, DEVBOX_HOST, LOCAL_HOST, environmentListOf, hostListOf } from './helpers/orca-answers.ts';
import { orcaHost, type HostWorkspace } from './helpers/orca-host.ts';
import { standIns } from './helpers/stand-ins.ts';

type Storage = NonNullable<MockHostOptions['storage']>;

let worker: TestWorker | undefined;
afterEach(async () => {
  await worker?.deactivate();
  worker = undefined;
  mock.timers.reset();
});

// Lines no figure reads, longer together than the window a refresh reads from a file's end.
const PADDING = `${JSON.stringify({ type: 'custom', note: 'x'.repeat(2000) })}\n`.repeat(Math.ceil((TAIL_BYTES * 1.5) / 2000));

// An omp Orca agent on the SSH target `devbox`, whose session file, larger than the window, has
// logged 0.10 USD: the file, the `ssh` and `orca` stand-ins, and `start`, which mounts a new
// worker on an Orca host that holds `storage` and grants `capabilities` (the manifest's when
// not given).
function devboxAgent() {
  useTempHome();
  const remoteHome = tempHome();
  const workspace: HostWorkspace = { project: 'infra', name: 'main', agents: ['working'], hostId: `ssh:${DEVBOX}`, sessionId: 's1' };
  const file = ompSession(remoteHome, join(remoteHome, 'work/infra-main'));
  appendFileSync(file, PADDING);
  const calls = standIns({
    homes: { devbox: remoteHome },
    orca: { 'host list --json': hostListOf(LOCAL_HOST, DEVBOX_HOST), 'environment list --json': environmentListOf() },
  });
  // the command lines `ssh devbox` has run so far
  const lines = () => calls.ssh().filter(([alias]) => alias === 'devbox').map((args) => args.at(-1)!);
  return { file, lines, start: (storage?: Storage, capabilities?: string[]) => start(remoteHome, workspace, storage, capabilities) };
}

// Ends the worker of the test, if any, and mounts a new one on an Orca host with `workspace`
// that holds `storage` and grants `capabilities`.
async function start(home: string, workspace: HostWorkspace, storage?: Storage, capabilities?: string[]) {
  await worker?.deactivate();
  const host = orcaHost(home, { workspaces: [workspace], storage, capabilities });
  worker = await mountWorker(workerModule, { host });
  return host;
}

// The only card of the fleet a refresh answers.
async function refresh() {
  const fleet = (await worker!.request('spyhop.fleet', { request: 1 })) as FleetAnswer;
  const cards = fleet.groups.flatMap((group) => group.cards);
  assert.equal(cards.length, 1);
  return cards[0];
}

// Which of `lines` scan a file: `dd`, and the `tail` that reads from a position.
const dds = (lines: string[]) => lines.filter((line) => line.startsWith(`'dd' `));
const tailsFrom = (lines: string[]) => lines.filter((line) => line.startsWith(`'tail' '-c' '+`));

// What the storage `storage` holds: the kept totals, under its one key.
function keptIn(storage: Record<string, unknown>) {
  const keys = Object.keys(storage);
  assert.equal(keys.length, 1);
  return {
    key: keys[0],
    value: storage[keys[0]] as { version: number; scans: { path: string; pos: number; state: { costUsd: { sum: number } } }[] },
  };
}

test('Scanned file is not scanned again after the worker restarts', async () => {
  const { file, lines, start } = devboxAgent();
  const first = await start();
  assert.equal(costOf(await refresh()), '$0.10');
  assert.equal(dds(lines()).length, 1);
  const scanned = statSync(file).size;
  appendFileSync(file, costTurn(0.2));
  const before = lines().length;

  const second = await start(first.data().storage as Storage);
  const card = await refresh();

  assert.equal(second.callsOf('storage.get').length, 1);
  assert.equal(second.calls.findIndex(({ method }) => method === 'storage.get'), 0);
  assert.deepEqual([first.refusals, second.refusals, worker!.refusals], [[], [], []]);
  const ran = lines().slice(before);
  assert.deepEqual(dds(ran), []);
  assert.deepEqual(tailsFrom(ran), [`'tail' '-c' '+${scanned}' '--' '${file}'`]);
  assert.equal(costOf(card), '$0.30');
});

test('Totals written at most every 30 seconds', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const { file, start } = devboxAgent();
  const host = await start();
  await refresh();
  assert.equal(host.callsOf('storage.set').length, 1);
  appendFileSync(file, costTurn(0.2));

  mock.timers.tick(10_000);
  assert.equal(costOf(await refresh()), '$0.30');
  assert.equal(host.callsOf('storage.set').length, 1);

  mock.timers.tick(20_000);
  await refresh();
  assert.equal(host.callsOf('storage.set').length, 2);
  const { scans } = keptIn(host.data().storage).value;
  assert.deepEqual(scans.map((scan) => scan.pos), [statSync(file).size]);
  assert.ok(Math.abs(scans[0].state.costUsd.sum - 0.3) < 1e-9, String(scans[0].state.costUsd.sum));

  for (let passed = 0; passed < 30_000; passed += 2000) {
    mock.timers.tick(2000);
    await refresh();
  }
  assert.equal(host.callsOf('storage.set').length, 2);
});

test('Claude Code totals are kept whole', async () => {
  const home = useTempHome();
  standIns({ homes: {}, orca: { 'host list --json': hostListOf(), 'environment list --json': environmentListOf() } });
  const workspace: HostWorkspace = { project: 'web', name: 'main', agents: ['working'], harness: 'claude' };
  const dir = join(home, '.claude/projects', sessionDirSlug(join(home, 'work/web-main')));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 's1.jsonl');
  // one content block of the response `r1`, which used 100 tokens
  const block = `${claudeAssistant('2026-11-25T11:59:00.000Z', 'r1', claudeUsage(10, 20, 30, 40))}\n`;
  writeFileSync(file, `${block}${PADDING}`);
  const first = await start(home, workspace);
  await refresh();
  assert.deepEqual(keptIn(first.data().storage).value.scans.map((scan) => scan.pos), [statSync(file).size]);

  const second = await start(home, workspace, first.data().storage as Storage);

  // the file is as the first worker scanned it, and the second one starts from that scan: no
  // scan of its own changed, so it writes nothing
  await refresh();
  assert.equal(second.callsOf('storage.set').length, 0);
  // a card builder that starts from the stored scan, as a new worker's does
  const cards = createAgentCards({ run, home, kept: decodeScans(keptIn(first.data().storage).value) });
  const agents = [agent({ agent: 'claude', path: join(home, 'work/web-main') })];
  assert.equal(tokensOf((await cards.build(agents, NOW))[0]), '100');
  // another content block of `r1`, which the kept responses hold: its tokens are counted once
  appendFileSync(file, block);
  assert.equal(tokensOf((await cards.build(agents, NOW))[0]), '100');
});

test('Stored value of another version or unreadable is ignored', async () => {
  const { lines, start } = devboxAgent();
  const first = await start();
  await refresh();
  const { key, value } = keptIn(first.data().storage);
  const scan = value.scans[0];
  // the same totals, but for another version's number and a cost of 99 USD
  const other = { ...value, version: value.version + 1, scans: [{ ...scan, state: { ...scan.state, costUsd: { ...scan.state.costUsd, sum: 99 } } }] };

  for (const stored of [other, 'not kept totals']) {
    const before = lines().length;
    await start({ [key]: stored } as Storage);
    const card = await refresh();

    assert.equal(dds(lines().slice(before)).length, 1, JSON.stringify(stored).slice(0, 40));
    assert.match(dds(lines().slice(before))[0], / 'skip=0' /);
    assert.equal(costOf(card), '$0.10');
  }
});

test('Scans of spyhop 0.1.0 are discarded once', async () => {
  const { file, lines, start } = devboxAgent();
  const first = await start();
  await refresh();
  const { key, value } = keptIn(first.data().storage);
  const scan = value.scans[0];
  // what spyhop 0.1.0 kept for the file: its version's number, a state without the contexts of
  // the model calls, and a cost of 99 USD that no scan of this version gives
  const { recent: _recent, ...state } = scan.state as typeof scan.state & { recent: unknown };
  const old = { version: 1, scans: [{ ...scan, state: { ...state, costUsd: { ...state.costUsd, sum: 99 } } }] };
  const before = lines().length;

  const updated = await start({ [key]: old } as Storage);
  const card = await refresh();

  const ran = dds(lines().slice(before));
  assert.equal(ran.length, 1);
  assert.match(ran[0], / 'skip=0' /);
  assert.equal(costOf(card), '$0.10');
  const kept = keptIn(updated.data().storage).value;
  assert.equal(kept.version, KEPT_VERSION);
  assert.deepEqual(kept.scans.map((s) => [s.path, s.state.costUsd.sum]), [[file, 0.1]]);

  const again = lines().length;
  await start(updated.data().storage as Storage);
  await refresh();
  assert.deepEqual(dds(lines().slice(again)), []);
});

test('File that is not the one scanned is scanned again', async () => {
  const { file, lines, start } = devboxAgent();
  const first = await start();
  await refresh();
  const scanned = statSync(file).size;
  // another session at that path: its turn of 0.70 USD, then one line that runs past the kept
  // position, so the byte before that position is no newline
  writeFileSync(file, `${costTurn(0.7)}${JSON.stringify({ type: 'custom', note: 'y'.repeat(scanned) })}\n`);
  const before = lines().length;

  await start(first.data().storage as Storage);
  const card = await refresh();

  const scans = lines().slice(before).filter((line) => dds([line]).length + tailsFrom([line]).length > 0);
  assert.equal(scans[0], `'tail' '-c' '+${scanned}' '--' '${file}'`);
  assert.match(scans[1], /^'dd' .* 'skip=0' /);
  assert.equal(costOf(card), '$0.70');
});

// An installed spyhop not yet approved for `storage:own`: Orca refuses both storage calls.
test('Storage that Orca refuses fails no request', async () => {
  const { start } = devboxAgent();
  const host = await start(undefined, ['workspace:read', 'agent:read', 'workspace:write']);

  const card = await refresh();

  assert.equal(costOf(card), '$0.10');
  assert.deepEqual(host.refusals.map(({ method, code }) => [method, code]), [
    ['storage.get', 'capability_denied'],
    ['storage.set', 'capability_denied'],
  ]);
  assert.deepEqual(worker!.logs, ['spyhop: cannot keep the session totals: storage.set needs the storage:own capability']);
});
