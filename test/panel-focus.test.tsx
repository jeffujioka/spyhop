// The open panel's rows follow focus: each time Orca reports (`workspace.changed`) that focus
// moved to another Orca workspace, the panel expands it, its project and its host, and collapses
// the workspace row it expanded before, unless the developer opened or closed that row since.
// The worker reads the harnesses' files with the real programs under a temporary home; the
// `orca` CLI and `ssh`, stood in for (test/helpers/stand-ins.ts), list the SSH host `devbox`.
import { setTimeout } from 'node:timers/promises';
import { afterEach, assert, mount, mountWorker, test, type TestPanel, type TestWorker } from 'orca/testing';
import * as panelModule from '../src/panel.tsx';
import * as workerModule from '../src/worker.ts';
import { useTempHome } from './helpers/env.ts';
import { tempHome } from './helpers/files.ts';
import { DEVBOX, DEVBOX_LISTS } from './helpers/orca-answers.ts';
import { orcaHost, type HostWorkspace } from './helpers/orca-host.ts';
import { isOpen, row } from './helpers/panel.ts';
import { standIns } from './helpers/stand-ins.ts';

let panel: TestPanel | undefined;
let worker: TestWorker | undefined;
afterEach(async () => {
  await panel?.unmount();
  await worker?.deactivate();
});

// Opens the panel, with its worker, on Orca's hosts with `workspaces`, `focused` focused.
// Returns the panel and `moveFocus(name)`, which focuses the workspace `name` as Orca does and
// waits for the panel to redraw.
async function open(workspaces: HostWorkspace[], focused: string) {
  const home = useTempHome();
  standIns({ homes: { devbox: tempHome() }, orca: DEVBOX_LISTS });
  const host = orcaHost(home, { workspaces, focused });
  worker = await mountWorker(workerModule, { host });
  panel = await mount(panelModule, { host });
  const view = panel;
  assert.deepEqual(view.errors, []);
  async function moveFocus(name: string) {
    await view.emit('workspace.changed', { context: host.focus(name) });
    await view.settled();
    assert.deepEqual(view.errors, []);
  }
  return { view, host, moveFocus };
}

test('Focus change expands the new workspace', async () => {
  const { view, moveFocus } = await open(
    [
      { project: 'api', name: 'fix-login', agents: ['working'] },
      { project: 'infra', name: 'deploy', agents: ['working'], hostId: `ssh:${DEVBOX}` },
    ],
    'fix-login',
  );
  // a collapsed row draws none of the rows under it
  assert.equal(isOpen(view, 'devbox'), false);
  assert.equal(view.find({ type: 'Collapsible', label: 'deploy' }), null);

  await moveFocus('deploy');

  for (const name of ['devbox', 'infra', 'deploy']) assert.equal(isOpen(view, name), true, name);
  const cards = view.findAll({ type: 'Card' }).filter((el) => el.path.startsWith(`${row(view, 'deploy')!.path}/`));
  assert.equal(cards.length, 1);
});

test('Focus change expands the new workspace before the worker answers again', async () => {
  const { view, host } = await open(
    [
      { project: 'api', name: 'fix-login', agents: ['working'] },
      { project: 'infra', name: 'deploy', agents: ['working'], hostId: `ssh:${DEVBOX}` },
    ],
    'fix-login',
  );
  const release = host.holdLists();

  // the event settles only once the worker has answered, which waits for the release
  const emitted = view.emit('workspace.changed', { context: host.focus('deploy') });
  try {
    await setTimeout(100);
    for (const name of ['devbox', 'infra', 'deploy']) assert.equal(isOpen(view, name), true, name);
    assert.equal(isOpen(view, 'fix-login'), false);
  } finally {
    release();
    await emitted;
  }
  // the answer, which names the same focus, changes no row
  await view.settled();
  for (const name of ['devbox', 'infra', 'deploy']) assert.equal(isOpen(view, name), true, name);
  assert.equal(isOpen(view, 'fix-login'), false);
  assert.deepEqual(view.errors, []);
});

test('An answer asked before focus moved again moves no row', async () => {
  const { view, host } = await open(
    [
      { project: 'api', name: 'fix-login', agents: ['working'] },
      { project: 'infra', name: 'deploy', agents: ['working'], hostId: `ssh:${DEVBOX}` },
    ],
    'fix-login',
  );
  let release = host.holdLists();
  // the worker's answer to this move names `deploy` focused; focus moves back before it is in
  const first = view.emit('workspace.changed', { context: host.focus('deploy') });
  await setTimeout(100);
  const second = view.emit('workspace.changed', { context: host.focus('fix-login') });
  try {
    await setTimeout(100);
    const asked = host.callsOf('workspace.list').length;
    release();
    // the answer asked again after the second move waits; it is asked once the stale answer
    // is drawn
    release = host.holdLists();
    while (host.callsOf('workspace.list').length === asked) await setTimeout(10);
    assert.equal(isOpen(view, 'fix-login'), true);
    assert.equal(isOpen(view, 'deploy'), false);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  await view.settled();
  assert.equal(isOpen(view, 'fix-login'), true);
  assert.equal(isOpen(view, 'deploy'), false);
  assert.deepEqual(view.errors, []);
});

test('Focus change while the panel is hidden shows at once when it is shown again', async () => {
  const { view, host } = await open(
    [
      { project: 'api', name: 'fix-login', agents: ['working'] },
      { project: 'infra', name: 'deploy', agents: ['working'], hostId: `ssh:${DEVBOX}` },
    ],
    'fix-login',
  );
  await view.setVisible(false);
  await view.emit('workspace.changed', { context: host.focus('deploy') });
  const release = host.holdLists();

  // shown again, the panel asks the worker, whose answer waits for the release
  const shown = view.setVisible(true);
  try {
    await setTimeout(100);
    for (const name of ['devbox', 'infra', 'deploy']) assert.equal(isOpen(view, name), true, name);
    assert.equal(isOpen(view, 'fix-login'), false);
  } finally {
    release();
    await shown;
  }
  await view.settled();
  for (const name of ['devbox', 'infra', 'deploy']) assert.equal(isOpen(view, name), true, name);
  assert.equal(isOpen(view, 'fix-login'), false);
  assert.deepEqual(view.errors, []);
});

test('Previously expanded workspace collapses', async () => {
  const { view, moveFocus } = await open(
    [
      { project: 'api', name: 'main', agents: ['working'] },
      { project: 'api', name: 'fix-login', agents: ['working'] },
    ],
    'fix-login',
  );
  assert.equal(isOpen(view, 'fix-login'), true);

  await moveFocus('main');

  assert.equal(isOpen(view, 'main'), true);
  assert.equal(isOpen(view, 'fix-login'), false);
  for (const name of ['local', 'api']) assert.equal(isOpen(view, name), true, name);
});

test('Rows the developer opened or closed stay', async () => {
  const { view, moveFocus } = await open(
    [
      { project: 'api', name: 'main', agents: ['working'] },
      { project: 'api', name: 'fix-login', agents: ['working'] },
      { project: 'api', name: 'release', agents: ['working'] },
    ],
    'fix-login',
  );
  await view.toggle(row(view, 'fix-login')!);
  await view.toggle(row(view, 'fix-login')!);
  await view.toggle(row(view, 'release')!);
  for (const name of ['fix-login', 'release']) assert.equal(isOpen(view, name), true, name);

  await moveFocus('main');

  for (const name of ['main', 'fix-login', 'release']) assert.equal(isOpen(view, name), true, name);
});
