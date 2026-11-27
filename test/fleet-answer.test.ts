// The worker's fleet answer (`spyhop.fleet`): the cards of every Orca host in the group of their
// host, this computer's first, a group's cards by Orca state, and each host's group posted to the
// panel as soon as it is built (`spyhop.group`). The worker is the real one, on this computer's
// Orca host as the test kit plays it (test/helpers/orca-host.ts); it reads the harnesses' files
// with the real programs under a temporary home, and the `orca` CLI and `ssh`, stood in for
// (test/helpers/stand-ins.ts), list and reach the SSH host `devbox` and the paired server `jeff`.
import { join } from 'node:path';
import { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { afterEach, assert, mountWorker, test, type TestWorker } from 'orca/testing';
import type { FleetAnswer, GroupPost } from '../src/protocol.ts';
import * as workerModule from '../src/worker.ts';
import { NOW, ompSessionOf } from './helpers/agent-cards.ts';
import { useTempHome } from './helpers/env.ts';
import { tempHome } from './helpers/files.ts';
import { DEVBOX, DEVBOX_LISTS, JEFF_AGENT_LIST, JEFF_LISTS, JEFF_TERMINAL_LIST } from './helpers/orca-answers.ts';
import { orcaHost, type HostWorkspace } from './helpers/orca-host.ts';
import { serverAgent } from './helpers/server-agent.ts';
import { answer, standIns } from './helpers/stand-ins.ts';

let worker: TestWorker | undefined;
afterEach(async () => {
  await worker?.deactivate();
  worker = undefined;
  mock.timers.reset();
});

// The SSH workspace `infra`/`main` on `devbox`, with one omp agent on the session `s1`, listed
// first; and this computer's workspace `api`/`main`, with two working omp agents, each on the
// session of its own title, both in sub-folders of the workspace folder.
const DEVBOX_MAIN: HostWorkspace = { project: 'infra', name: 'main', agents: ['working'], hostId: `ssh:${DEVBOX}`, sessionId: 's1' };
const LOCAL_MAIN: HostWorkspace = { project: 'api', name: 'main', agents: ['working', 'working'], titles: ['π - Write the docs', 'π - Fix the login bug'] };

// The worker on Orca's hosts with the workspaces above, `devbox` reached under its own home;
// `held`: every command on `devbox` is held back until released.
async function twoHosts(held: string[] = []) {
  const home = useTempHome();
  const remoteHome = tempHome();
  ompSessionOf(remoteHome, join(home, 'work/infra-main'));
  const local = join(home, 'work/api-main');
  ompSessionOf(home, join(local, 'docs'), 0.1, 'Write the docs');
  ompSessionOf(home, join(local, 'login'), 0.2, 'Fix the login bug');
  const calls = standIns({ homes: { devbox: remoteHome }, orca: DEVBOX_LISTS, held });
  worker = await mountWorker(workerModule, { host: orcaHost(home, { workspaces: [DEVBOX_MAIN, LOCAL_MAIN] }) });
  return calls;
}

// The worker on this computer's Orca host with `workspaces`, and no other Orca host.
async function localHost(workspaces: HostWorkspace[]) {
  const home = useTempHome();
  standIns({ homes: {}, orca: DEVBOX_LISTS });
  worker = await mountWorker(workerModule, { host: orcaHost(home, { workspaces }) });
}

const fleet = (request = 1) => worker!.request('spyhop.fleet', { request }) as Promise<FleetAnswer>;
const groupsOf = (answer: FleetAnswer) => answer.groups.map((group) => [group.name, group.count, group.cards.length]);

// The worker's posts of groups so far.
const groupPosts = () => worker!.posts.filter(({ event }) => event === 'spyhop.group').map(({ payload }) => payload as GroupPost);

test('Groups by host, this computer first', async () => {
  await twoHosts();

  const answered = await fleet();

  assert.deepEqual(groupsOf(answered), [
    ['local', 2, 2],
    ['devbox', 1, 1],
  ]);
  assert.deepEqual(answered.counts, { working: 3 });
  // each local agent on its own session
  assert.deepEqual(answered.groups[0].cards.map((card) => [card.title, card.cost]), [
    ['Write the docs', 0.1],
    ['Fix the login bug', 0.2],
  ]);
});

test('Sessions ordered by Orca state', async () => {
  await localHost([{ project: 'api', name: 'main', agents: ['done', 'waiting', 'working', 'blocked', 'working'], titles: ['a', 'b', 'c', 'd', 'e'] }]);

  const [local] = (await fleet()).groups;

  assert.deepEqual(local.cards.map((card) => card.title), ['d', 'b', 'c', 'e', 'a']);
});

test('Workspace without agents is left out', async () => {
  await localHost([
    { project: 'api', name: 'main', agents: ['working'] },
    { project: 'api', name: 'empty', agents: [] },
    { project: 'infra', name: 'main', agents: [], hostId: `ssh:${DEVBOX}` },
  ]);

  assert.deepEqual(groupsOf(await fleet()), [['local', 1, 1]]);
});

test('One unreadable workspace leaves the others drawn', async () => {
  await localHost([
    { project: 'api', name: 'gone', agents: ['working'], unreadable: true },
    { project: 'api', name: 'main', agents: ['working'] },
  ]);

  assert.deepEqual(groupsOf(await fleet()), [['local', 1, 1]]);
});

test("each host's group is posted as soon as it is built", async () => {
  const calls = await twoHosts(['ssh devbox']);

  const answering = fleet(7);
  // this computer's group, while every command on `devbox` is held
  const end = Date.now() + 5000;
  while (groupPosts().length === 0) {
    if (Date.now() > end) throw new Error('the worker posted no group');
    await setImmediate();
  }
  assert.deepEqual(groupPosts().map((post) => [post.request, post.group.name]), [[7, 'local']]);
  calls.release('ssh devbox');
  const answered = await answering;

  // each host's group once, as the answer holds it
  assert.deepEqual(groupPosts(), [
    { request: 7, group: answered.groups[0] },
    { request: 7, group: answered.groups[1] },
  ]);
  assert.equal(answered.request, 7);
});

// A guard of where a card's time in its Orca state comes from, no scenario of the spec: Orca's
// `stateStartedAt` for an agent of this computer, the paired server's `updatedAt` for one of its
// agents, an ISO text here.
test("a card's time in its Orca state is Orca's", async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const home = useTempHome();
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'work/spyhop-main');
  const listed = { ...serverAgent(folder, 'main', 'tab1:leaf2'), updatedAt: new Date(NOW - 60_000).toISOString() };
  standIns({
    homes: { jeff: remoteHome },
    orca: { ...JEFF_LISTS, [JEFF_AGENT_LIST]: answer({ agents: [listed] }), [JEFF_TERMINAL_LIST]: answer({ terminals: [], totalCount: 0, truncated: false }) },
  });
  const workspaces: HostWorkspace[] = [{ project: 'api', name: 'main', agents: ['working'], stateStartedAt: NOW - 180_000 }];
  worker = await mountWorker(workerModule, { host: orcaHost(home, { workspaces }) });

  const { groups } = await fleet();

  assert.deepEqual(groups.map((group) => [group.name, group.cards.map((card) => card.stateSinceMs)]), [
    ['local', [180_000]],
    ['jeff', [60_000]],
  ]);
});
