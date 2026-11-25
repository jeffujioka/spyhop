// The right-sidebar panel over the plugin's own worker: the tree of Orca host → Orca project →
// Orca workspace → cards, with the focused workspace expanded when the panel opens. The worker
// reads the harnesses' files with the real programs under a temporary home.
import { afterEach, assert, mount, mountWorker, test, type MockHost, type TestElement, type TestPanel, type TestWorker } from 'orca/testing';
import * as panelModule from '../src/panel.tsx';
import * as workerModule from '../src/worker.ts';
import { tempHome } from './helpers/agent-cards.ts';
import { orcaHost, type HostWorkspace } from './helpers/orca-host.ts';

let panel: TestPanel | undefined;
let worker: TestWorker | undefined;
const realHome = process.env.HOME;
afterEach(async () => {
  await panel?.unmount();
  await worker?.deactivate();
  process.env.HOME = realHome;
});

// Opens the panel, with its worker, on this computer's Orca host.
async function open(workspaces: HostWorkspace[], focused?: string) {
  const home = tempHome();
  process.env.HOME = home;
  const host: MockHost = orcaHost(home, { workspaces, focused });
  worker = await mountWorker(workerModule, { host });
  panel = await mount(panelModule, { host });
  assert.deepEqual(panel.errors, []);
  assert.deepEqual(panel.refusals, []);
  return panel;
}

const row = (view: TestPanel, name: string) => view.find({ type: 'Collapsible', label: name });
// Whether the row `name` is drawn under the row `parent`.
const under = (view: TestPanel, name: string, parent: string) =>
  row(view, name)?.path.startsWith(`${row(view, parent)?.path}/`) ?? false;
// The cards `view` draws in `outer`.
const cardsIn = (view: TestPanel, outer: TestElement) =>
  view.findAll({ type: 'Card' }).filter((el) => el.path.startsWith(`${outer.path}/`));

test('Agents in two workspaces of one project', async () => {
  const view = await open(
    [
      { project: 'api', name: 'main', agents: ['working'] },
      { project: 'api', name: 'fix-login', agents: ['waiting'] },
    ],
    'main',
  );
  assert.equal(under(view, 'api', 'local'), true);
  assert.equal(under(view, 'main', 'api'), true);
  assert.equal(under(view, 'fix-login', 'api'), true);
  assert.equal(cardsIn(view, row(view, 'main')!).length, 1);
  await view.toggle(row(view, 'fix-login')!);
  assert.equal(cardsIn(view, row(view, 'fix-login')!).length, 1);
  // a card draws its five groups in order, the identity group with every figure of it
  const [card] = cardsIn(view, row(view, 'main')!);
  const groups = view.findAll({ type: 'KeyValue' }).filter((el) => el.path.startsWith(`${card.path}/`));
  assert.deepEqual(
    groups.map((group) => group.label),
    ['IDENTITY', 'CONTEXT', 'SPEND', 'CACHE', 'ACTIVITY'],
  );
  const identity = groups[0].props.items as { label: string; value: unknown }[];
  assert.deepEqual(
    identity.map((item) => item.label),
    ['Session', 'Path', 'Branch', 'Remote', 'Machine', 'Harness', 'Model'],
  );
  assert.equal(identity.find((item) => item.label === 'Path')?.value, '~/work/api-main');
  assert.equal(identity.find((item) => item.label === 'Harness')?.value, 'omp');
  // Orca's own status words, `waiting` in a colour of its own
  const tones = view.findAll({ type: 'Badge' }).map((badge) => [badge.text, badge.props.tone]);
  assert.deepEqual(tones, [
    ['working', 'accent'],
    ['waiting', 'warning'],
  ]);
});

test('Workspace without agents is left out', async () => {
  const view = await open(
    [
      { project: 'api', name: 'main', agents: ['working'] },
      { project: 'api', name: 'docs', agents: [] },
      { project: 'notes', name: 'main', agents: [] },
    ],
    'main',
  );
  assert.equal(under(view, 'api', 'local'), true);
  assert.equal(under(view, 'main', 'api'), true);
  assert.equal(row(view, 'docs'), null);
  assert.equal(row(view, 'notes'), null);
});

test('One unreadable workspace leaves the others drawn', async () => {
  const view = await open(
    [
      { project: 'api', name: 'main', agents: ['working'] },
      { project: 'api', name: 'gone', agents: ['working'], unreadable: true },
    ],
    'main',
  );
  assert.equal(under(view, 'main', 'api'), true);
  assert.equal(cardsIn(view, row(view, 'main')!).length, 1);
  assert.equal(row(view, 'gone'), null);
});

test('Focused workspace open on first draw', async () => {
  const view = await open(
    [
      { project: 'api', name: 'main', agents: ['working'] },
      { project: 'api', name: 'fix-login', agents: ['working'] },
    ],
    'fix-login',
  );
  for (const name of ['local', 'api', 'fix-login']) assert.equal(view.valueOf(row(view, name)!), true, name);
  assert.equal(cardsIn(view, row(view, 'fix-login')!).length, 1);
  assert.equal(view.valueOf(row(view, 'main')!), false);
  assert.equal(cardsIn(view, row(view, 'main')!).length, 0);
});
