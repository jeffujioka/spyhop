// The open panel builds its tree again every REFRESH_INTERVAL_MS and redraws it; a closed panel,
// hidden or unmounted, builds nothing. Each request starts REFRESH_INTERVAL_MS after the previous
// one started, or at its answer when that came later. Time is node:test's mock clock, and an
// answer comes late by holding back the host's `workspace.list`; the worker reads the
// session file with the real programs under a temporary home, and the `orca` CLI, stood in for
// (test/helpers/stand-ins.ts), lists no other Orca host.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { afterEach, assert, hostError, mount, mountWorker, test, type TestPanel, type TestWorker } from 'orca/testing';
import { REFRESH_INTERVAL_MS } from '../src/core/refresh.js';
import * as panelModule from '../src/panel.tsx';
import * as workerModule from '../src/worker.ts';
import { costTurn, ompSessionOf } from './helpers/agent-cards.ts';
import { useTempHome } from './helpers/env.ts';
import { orcaHost } from './helpers/orca-host.ts';
import { standIns } from './helpers/stand-ins.ts';

let panel: TestPanel | undefined;
let worker: TestWorker | undefined;
afterEach(async () => {
  await panel?.unmount();
  await worker?.deactivate();
  mock.timers.reset();
});

// One Orca workspace `api`/`main` holding one omp agent whose session has logged 0.10 USD, with
// the worker mounted and the clock mocked. Returns the host, the session file and the CLI's calls.
async function session() {
  const home = useTempHome();
  const cli = standIns({ homes: {}, orca: {} });
  const host = orcaHost(home, { workspaces: [{ project: 'api', name: 'main', agents: ['working'], sessionId: 's1' }], focused: 'main' });
  const file = ompSessionOf(home, join(home, 'work/api-main'));
  mock.timers.enable({ apis: ['setTimeout'] });
  worker = await mountWorker(workerModule, { host });
  return { host, file, cli };
}

// Opens the panel on that session. Returns the panel, the session file and the CLI's calls.
async function openOnSession() {
  const { host, file, cli } = await session();
  panel = await mount(panelModule, { host });
  assert.deepEqual(panel.errors, []);
  return { view: panel, file, cli };
}

// Opens the panel on that session with the answer to its first request held back: the mount
// resolves only once the panel has drawn it. Returns once that request has started, with
// `requests()`, how many the panel has started, and `answer()`, which lets the answer arrive and
// returns the panel once it has drawn it.
async function openWithAnswerHeld() {
  const { host } = await session();
  const requests = () => host.callsOf('workspace.list').length;
  const release = host.holdLists();
  const opening = mount(panelModule, { host });
  while (requests() === 0) await setImmediate();
  async function answer() {
    release();
    panel = await opening;
    await panel.settled();
    assert.deepEqual(panel.errors, []);
    return panel;
  }
  return { requests, answer };
}

const costOf = (view: TestPanel) =>
  (view.find({ type: 'KeyValue', label: 'SPEND' })?.props.items as { value: string }[] | undefined)?.[0]?.value;

// Lets 2 seconds pass, and waits for what they started.
async function twoSecondsPass(view: TestPanel) {
  mock.timers.tick(REFRESH_INTERVAL_MS);
  await view.settled();
}

test('Open panel refreshes', async () => {
  const { view, file } = await openOnSession();
  assert.equal(costOf(view), '$0.10');

  appendFileSync(file, costTurn(0.15));
  await twoSecondsPass(view);

  assert.equal(costOf(view), '$0.25');
  assert.deepEqual(view.errors, []);
});

test('A failed refresh keeps the tree and the next one redraws', async () => {
  const { view, file } = await openOnSession();
  appendFileSync(file, costTurn(0.15));

  view.host.respond('workspace.readContext', () => {
    throw hostError('unavailable');
  });
  await twoSecondsPass(view);
  assert.equal(costOf(view), '$0.10');
  assert.deepEqual(view.errors, []);

  view.host.respond('workspace.readContext', null);
  await twoSecondsPass(view);
  assert.equal(costOf(view), '$0.25');
});

test('Closed panel reads nothing', async () => {
  const { view, cli } = await openOnSession();
  const builds = () => view.host.callsOf('workspace.list').length;
  // open, it builds again every 2 seconds
  await twoSecondsPass(view);
  assert.equal(builds(), 2);

  // hidden as Orca reports it: no build, so no agent listed, no session read, no command
  await view.setVisible(false);
  const calls = view.host.calls.length;
  const commands = cli.orca().length;
  await twoSecondsPass(view);
  await twoSecondsPass(view);
  assert.equal(view.host.calls.length, calls);
  assert.equal(cli.orca().length, commands);

  // shown again, it builds at once; unmounted, never again
  await view.setVisible(true);
  assert.equal(builds(), 3);
  await view.unmount();
  const left = view.host.calls.length;
  await twoSecondsPass(view);
  assert.equal(view.host.calls.length, left);
});

test('Next request starts 2 seconds after the previous one started', async () => {
  const { requests, answer } = await openWithAnswerHeld();

  // the answer arrives 1.5 seconds after the request started
  mock.timers.tick(1500);
  const view = await answer();
  assert.equal(costOf(view), '$0.10');
  mock.timers.tick(REFRESH_INTERVAL_MS - 1500 - 1);
  await view.settled();
  assert.equal(requests(), 1);

  mock.timers.tick(1);
  await view.settled();
  assert.equal(requests(), 2);
  assert.deepEqual(view.errors, []);
});

test('Answer slower than 2 seconds', async () => {
  const { requests, answer } = await openWithAnswerHeld();

  mock.timers.tick(3000);
  // what the 3 seconds started, if anything, runs: no time passes
  await setImmediate();
  assert.equal(requests(), 1);

  // the answer arrives: the second request starts with no more time passing
  await answer();
  assert.equal(requests(), 2);
});
