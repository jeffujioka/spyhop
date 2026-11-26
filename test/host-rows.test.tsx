// Host rows drawn as built: during a refresh the worker posts each Orca host's row as soon as
// that host's cards are built, and the panel draws it without waiting for another host; the
// answer then replaces the whole tree, and a row built for an older request is ignored. The
// worker and the panel are the real ones, on this computer's Orca host as the test kit plays it;
// the worker reads the harnesses' files with the real programs under a temporary home, and the
// `orca` CLI and `ssh`, stood in for (test/helpers/stand-ins.ts), list the SSH host `devbox`,
// whose answers a test holds back. The test kit hands the panel none of the worker's posts, so
// the tests hand them on (`relayPosts`, test/helpers/orca-host.ts). The clock is node:test's mock
// clock: the panel asks again only when a test lets 2 seconds pass.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { afterEach, assert, mount, mountWorker, test, type TestPanel, type TestWorker } from 'orca/testing';
import { REFRESH_INTERVAL_MS } from '../src/core/refresh.js';
import * as panelModule from '../src/panel.tsx';
import type { HostRowPost } from '../src/protocol.ts';
import * as workerModule from '../src/worker.ts';
import { costOf, costTurn, ompSessionOf } from './helpers/agent-cards.ts';
import { useTempHome } from './helpers/env.ts';
import { tempHome } from './helpers/files.ts';
import { DEVBOX, DEVBOX_LISTS } from './helpers/orca-answers.ts';
import { orcaHost, relayPosts, type HostWorkspace } from './helpers/orca-host.ts';
import { cardFolders, isOpen, row } from './helpers/panel.ts';
import { standIns } from './helpers/stand-ins.ts';

let panel: TestPanel | undefined;
let worker: TestWorker | undefined;
afterEach(async () => {
  await panel?.unmount();
  await worker?.deactivate();
  panel = undefined;
  worker = undefined;
  mock.timers.reset();
});

const MAIN: HostWorkspace = { project: 'api', name: 'main', agents: ['working'], sessionId: 's1' };
const DEPLOY: HostWorkspace = { project: 'infra', name: 'deploy', agents: ['working'], hostId: `ssh:${DEVBOX}` };

// The worker on Orca's hosts with `workspaces`, `main` focused, the SSH host `devbox` listed and
// the clock mocked; `held`: what the stand-ins hold back. Returns this computer's home folder,
// Orca's host, the worker and the stand-ins' calls.
async function start(workspaces: HostWorkspace[], held: string[] = []) {
  const home = useTempHome();
  const calls = standIns({ homes: { devbox: tempHome() }, orca: DEVBOX_LISTS, held });
  const host = orcaHost(home, { workspaces, focused: 'main' });
  mock.timers.enable({ apis: ['setTimeout'] });
  worker = await mountWorker(workerModule, { host });
  return { home, host, calls, posts: worker.posts };
}

// The folders of the cards under the workspace row `workspace`, in the project row `project` of
// the host row `host`, each of the three opened first when it is drawn closed.
async function cardsIn(view: TestPanel, host: string, project: string, workspace: string) {
  for (const name of [host, project, workspace]) if (!isOpen(view, name)) await view.toggle(row(view, name)!);
  const [hostRow, projectRow, workspaceRow] = [host, project, workspace].map((name) => row(view, name)!);
  assert.ok(projectRow.path.startsWith(`${hostRow.path}/`) && workspaceRow.path.startsWith(`${projectRow.path}/`));
  return cardFolders(view, workspaceRow);
}

// The cost of each card the panel draws.
const costs = (view: TestPanel) =>
  view.findAll({ type: 'KeyValue', label: 'SPEND' }).map((el) => (el.props.items as { value: string }[])[0].value);

test("This computer's rows before a slow remote host answers", async () => {
  const { host, calls, posts } = await start([MAIN, { project: 'api', name: 'fix-login', agents: ['working'] }, DEPLOY], ['ssh devbox']);
  // mounted hidden, the panel asks nothing; shown, it opens: its first request is answered only
  // once `devbox` is, and the kit resolves no act of the panel before that
  panel = await mount(panelModule, { host, visible: false });
  const view = panel;
  const opened = view.setVisible(true);
  // set once focus moves: the event settles only once the worker has answered
  let moved: Promise<void> | undefined;
  try {
    // `devbox` was asked, and its answers are held back
    await calls.until(() => calls.ssh().some(([alias]) => alias === 'devbox'));
    await relayPosts(posts, view, 1);

    assert.equal(row(view, 'devbox'), null);
    for (const name of ['local', 'api', 'main']) assert.equal(isOpen(view, name), true, name);
    assert.deepEqual(await cardsIn(view, 'local', 'api', 'main'), ['api-main']);
    assert.equal(view.find({ type: 'Card', label: 'main' })?.props.description, 'local · api');

    // focus moves while `devbox` has still not answered: a row of the request, which names the
    // focus at its start, arriving after the move leaves the focus where it moved to
    moved = view.emit('workspace.changed', { context: host.focus('fix-login') });
    await relayPosts(posts, view, 1);
    assert.equal(view.find({ type: 'Card', label: 'fix-login' })?.props.description, 'local · api');
    assert.equal(view.find({ type: 'Card', label: 'main' }), null);
    assert.equal(isOpen(view, 'fix-login'), true);
    assert.equal(isOpen(view, 'main'), false);
  } finally {
    calls.release('ssh devbox');
    await opened;
    await moved;
  }

  assert.deepEqual(await cardsIn(view, 'devbox', 'infra', 'deploy'), ['infra-deploy']);
  assert.deepEqual(await cardsIn(view, 'local', 'api', 'main'), ['api-main']);
  assert.deepEqual(view.errors, []);
});

test('Host rows of an older request are ignored', async () => {
  const { home, host, posts } = await start([MAIN]);
  const file = ompSessionOf(home, join(home, 'work/api-main'));
  panel = await mount(panelModule, { host });
  const view = panel;
  appendFileSync(file, costTurn(0.15));
  mock.timers.tick(REFRESH_INTERVAL_MS);
  await view.settled();
  // the Focused block's card and the row's
  assert.deepEqual(costs(view), ['$0.25', '$0.25']);
  // the rows of `local` built for the first request
  const older = posts[0].payload as HostRowPost;
  assert.deepEqual([posts.length, older.host.id, costOf(older.host.projects[0].workspaces[0].cards[0])], [2, 'local', '$0.10']);

  await view.post('spyhop.host', older);
  assert.deepEqual(costs(view), ['$0.25', '$0.25']);
  // nor is a row of the newest request, once its answer is drawn
  await view.post('spyhop.host', { ...older, request: older.request + 1 });
  assert.deepEqual(costs(view), ['$0.25', '$0.25']);

  // nor while a newer request is being answered: its answer waits for the release
  const release = host.holdLists();
  mock.timers.tick(REFRESH_INTERVAL_MS);
  while (host.callsOf('workspace.list').length < 3) await setImmediate();
  const heard = view.post('spyhop.host', older);
  try {
    // the panel's draw runs in the task `post` queued, before this one
    await setImmediate();
    assert.deepEqual(costs(view), ['$0.25', '$0.25']);
    // a row of the request being answered takes the place of the drawn row of its host
    void view.post('spyhop.host', { ...older, request: older.request + 2 });
    await setImmediate();
    assert.deepEqual(costs(view), ['$0.10', '$0.10']);
    assert.equal(view.findAll({ type: 'Collapsible', label: 'local' }).length, 1);
  } finally {
    release();
    await heard;
  }
  // the answer replaces it
  assert.deepEqual(costs(view), ['$0.25', '$0.25']);
  assert.deepEqual(view.errors, []);
});

test('Host that is gone disappears with the answer', async () => {
  const { host } = await start([MAIN, DEPLOY]);
  panel = await mount(panelModule, { host });
  const view = panel;
  assert.deepEqual(await cardsIn(view, 'local', 'api', 'main'), ['api-main']);
  assert.deepEqual(await cardsIn(view, 'devbox', 'infra', 'deploy'), ['infra-deploy']);

  host.remove('deploy');
  mock.timers.tick(REFRESH_INTERVAL_MS);
  await view.settled();

  assert.deepEqual(await cardsIn(view, 'local', 'api', 'main'), ['api-main']);
  assert.equal(row(view, 'devbox'), null);
  assert.deepEqual(view.errors, []);
});
