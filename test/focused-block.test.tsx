// The Focused block above the tree: the focused Orca workspace's name, its Orca host and Orca
// project, and its cards, Focus pane buttons included; it follows focus at the
// `workspace.changed` event, and is not drawn while the focused workspace has no Orca agent.
// The worker reads the harnesses' files with the real programs under a temporary home; the
// `orca` CLI and `ssh`, stood in for (test/helpers/stand-ins.ts), list the SSH host `devbox`.
import { setTimeout } from 'node:timers/promises';
import { afterEach, assert, mount, mountWorker, test, type TestElement, type TestPanel, type TestWorker, type TreeSnapshot } from 'orca/testing';
import * as panelModule from '../src/panel.tsx';
import * as workerModule from '../src/worker.ts';
import { useTempHome } from './helpers/env.ts';
import { tempHome } from './helpers/files.ts';
import { DEVBOX, DEVBOX_LISTS } from './helpers/orca-answers.ts';
import { orcaHost, type HostWorkspace } from './helpers/orca-host.ts';
import { cardFolders } from './helpers/panel.ts';
import { standIns } from './helpers/stand-ins.ts';

let panel: TestPanel | undefined;
let worker: TestWorker | undefined;
afterEach(async () => {
  await panel?.unmount();
  await worker?.deactivate();
});

// Opens the panel, with its worker, on Orca's hosts with `workspaces`, `focused` focused.
// Returns the panel and Orca's host, whose `focus(name)` focuses the workspace `name` as Orca
// does.
async function open(workspaces: HostWorkspace[], focused: string) {
  const home = useTempHome();
  standIns({ homes: { devbox: tempHome() }, orca: DEVBOX_LISTS });
  const host = orcaHost(home, { workspaces, focused });
  worker = await mountWorker(workerModule, { host });
  panel = await mount(panelModule, { host });
  const view = panel;
  assert.deepEqual(view.errors, []);
  return { view, host };
}

// The Focused block: the card titled `name`, drawn before the tree's host row `local`.
function block(view: TestPanel, name: string) {
  const found = view.find({ type: 'Card', label: name });
  if (!found) return null;
  const root = view.tree() as TreeSnapshot;
  const titles = (root.children ?? []).map((child) => (typeof child === 'string' ? child : child.props?.title));
  assert.ok(titles.indexOf(name) >= 0 && titles.indexOf(name) < titles.indexOf('local'), JSON.stringify(titles));
  return found;
}
const within = (outer: TestElement, el: TestElement) => el.path.startsWith(`${outer.path}/`);

test('Focused block on first draw', async () => {
  const { view } = await open(
    [
      { project: 'api', name: 'main', agents: ['working'] },
      { project: 'api', name: 'fix-login', agents: ['working'] },
    ],
    'fix-login',
  );

  const focused = block(view, 'fix-login');
  assert.ok(focused, JSON.stringify(view.tree()));
  assert.equal(focused.props.description, 'local · api');
  assert.equal(view.find({ type: 'Card', label: 'main' }), null);
  assert.deepEqual(cardFolders(view, focused), ['api-fix-login']);
  const buttons = view.findAll({ type: 'Button', text: 'Focus pane' }).filter((el) => within(focused, el));
  assert.equal(buttons.length, 1);
});

test('Focused block follows focus', async () => {
  const { view, host } = await open(
    [
      { project: 'api', name: 'fix-login', agents: ['working'] },
      { project: 'infra', name: 'deploy', agents: ['working'], hostId: `ssh:${DEVBOX}` },
    ],
    'fix-login',
  );
  assert.ok(block(view, 'fix-login'));
  const release = host.holdLists();

  // the event settles only once the worker has answered, which waits for the release
  const emitted = view.emit('workspace.changed', { context: host.focus('deploy') });
  try {
    await setTimeout(100);
    assert.equal(block(view, 'deploy')?.props.description, 'devbox · infra');
    assert.equal(view.find({ type: 'Card', label: 'fix-login' }), null);
  } finally {
    release();
    await emitted;
  }
  await view.settled();

  const focused = block(view, 'deploy');
  assert.ok(focused, JSON.stringify(view.tree()));
  assert.equal(focused.props.description, 'devbox · infra');
  assert.equal(view.find({ type: 'Card', label: 'fix-login' }), null);
  assert.deepEqual(cardFolders(view, focused), ['infra-deploy']);
  assert.deepEqual(view.errors, []);
});

test('Focused workspace without agents', async () => {
  const { view, host } = await open(
    [
      { project: 'api', name: 'main', agents: ['working'] },
      { project: 'api', name: 'docs', agents: [] },
    ],
    'main',
  );
  assert.ok(block(view, 'main'));
  // no Focused block, and the row `main`, which the panel expanded, collapsed under `api`
  const followed = () => {
    assert.equal(view.find({ type: 'Card', label: 'main' }), null);
    assert.equal(view.find({ type: 'Card', label: 'docs' }), null);
    const main = view.find({ type: 'Collapsible', label: 'main' });
    const api = view.find({ type: 'Collapsible', label: 'api' });
    assert.ok(main && api && within(api, main));
    assert.equal(view.valueOf(main), false);
  };
  const release = host.holdLists();

  // the event settles only once the worker has answered, which waits for the release
  const emitted = view.emit('workspace.changed', { context: host.focus('docs') });
  try {
    await setTimeout(100);
    followed();
  } finally {
    release();
    await emitted;
  }
  await view.settled();

  followed();
  assert.deepEqual(view.errors, []);
});
