// The open panel's rows follow focus: each time Orca reports (`workspace.changed`) that focus
// moved to another Orca workspace, the panel expands it, its project and its host, and collapses
// the workspace row it expanded before, unless the developer opened or closed that row since.
// The worker reads the harnesses' files with the real programs under a temporary home; the
// `orca` CLI and `ssh`, stood in for (test/helpers/stand-ins.ts), list the SSH host `devbox`.
import { afterEach, assert, mount, mountWorker, test, type TestPanel, type TestWorker } from 'orca/testing';
import * as panelModule from '../src/panel.tsx';
import * as workerModule from '../src/worker.ts';
import { useTempHome } from './helpers/env.ts';
import { tempHome } from './helpers/files.ts';
import { orcaHost, type HostWorkspace } from './helpers/orca-host.ts';
import { answer, standIns } from './helpers/stand-ins.ts';

let panel: TestPanel | undefined;
let worker: TestWorker | undefined;
afterEach(async () => {
  await panel?.unmount();
  await worker?.deactivate();
});

// Orca's id of the SSH target `devbox`, as `orca host list` gives it on this Mac.
const DEVBOX = 'ssh-1795031810693-d3v8ox';

// Opens the panel, with its worker, on Orca's hosts with `workspaces`, `focused` focused.
// Returns the panel and `moveFocus(name)`, which focuses the workspace `name` as Orca does and
// waits for the panel to redraw.
async function open(workspaces: HostWorkspace[], focused: string) {
  const home = useTempHome();
  standIns({
    homes: { devbox: tempHome() },
    orca: {
      'host list --json': answer({ hosts: [{ kind: 'ssh', name: 'devbox', id: DEVBOX, selector: `--host ssh:${DEVBOX}`, connected: true }] }),
      'environment list --json': answer({ environments: [] }),
    },
  });
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
  return { view, moveFocus };
}

const row = (view: TestPanel, name: string) => view.find({ type: 'Collapsible', label: name })!;
const isOpen = (view: TestPanel, name: string) => view.valueOf(row(view, name));

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
  const cards = view.findAll({ type: 'Card' }).filter((el) => el.path.startsWith(`${row(view, 'deploy').path}/`));
  assert.equal(cards.length, 1);
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
  await view.toggle(row(view, 'fix-login'));
  await view.toggle(row(view, 'fix-login'));
  await view.toggle(row(view, 'release'));
  for (const name of ['fix-login', 'release']) assert.equal(isOpen(view, name), true, name);

  await moveFocus('main');

  for (const name of ['main', 'fix-login', 'release']) assert.equal(isOpen(view, name), true, name);
});
