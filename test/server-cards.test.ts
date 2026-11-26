// A paired Orca server's cards while its lists load: a refresh builds the cards of the agents the
// server listed at the previous refresh while `orca agent list --environment` and `orca terminal
// list --environment` run, uses them when the new list names the same agents, with each agent's
// state and pane from the new list, and builds the cards again when it differs. The worker is the
// real one; the `orca` CLI and `ssh`, stood in for (test/helpers/stand-ins.ts), play the paired
// server `jeff`, read over `ssh jeff`, and log their calls. Each refresh has its own stand-ins,
// so its own answers and call log; the second one's `orca agent list` answer is held back until
// the session folder was listed over ssh.
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, assert, mountWorker, test, type TestWorker } from 'orca/testing';
import type { TreeAnswer } from '../src/protocol.ts';
import * as workerModule from '../src/worker.ts';
import { costOf, costTurn, ompSessionOf as ompSession } from './helpers/agent-cards.ts';
import { useTempHome } from './helpers/env.ts';
import { tempHome } from './helpers/files.ts';
import { orcaHost } from './helpers/orca-host.ts';
import { answer, standIns } from './helpers/stand-ins.ts';

let worker: TestWorker | undefined;
afterEach(async () => {
  await worker?.deactivate();
  worker = undefined;
});

const AGENT_LIST = 'agent list --environment jeff --json';

// An omp Orca agent of the server, in its workspace `name` of its project `spyhop`, whose folder
// is `folder`, in the pane `paneKey`.
const serverAgent = (folder: string, name: string, paneKey: string, fields: { state?: string; title?: string } = {}) => ({
  orcaSessionId: `session-${name}`,
  kind: 'terminal',
  agent: 'omp',
  state: 'working',
  worktreeId: `repo-spyhop::${folder}`,
  workspace: name,
  repo: 'spyhop',
  hostId: 'local',
  paneKey,
  title: null,
  updatedAt: 0,
  ...fields,
});

// The stand-ins of one refresh: the paired server `jeff`, whose home folder is `remoteHome`,
// lists `agents`, and its terminal `terminal` in the tab `tab1` and its leaf `leaf2`; `held`:
// the answer to `orca agent list` is held back until released.
function jeffLists(remoteHome: string, agents: object[], terminal: string, held = false) {
  return standIns({
    homes: { jeff: remoteHome },
    orca: {
      'host list --json': answer({ hosts: [{ kind: 'local', name: 'this machine', id: 'local', selector: '--host local' }] }),
      'environment list --json': answer({ environments: [{ id: 'dc9a64c1-6450-46a1-a62c-9b03d06b187a', name: 'jeff', connectionDependency: 'ssh-tunnel' }] }),
      [AGENT_LIST]: answer({ agents }),
      'terminal list --environment jeff --json': answer({
        terminals: [{ handle: terminal, ptyId: 'pty-1', orphaned: false, tabId: 'tab1', leafId: 'leaf2', title: 'omp', connected: true }],
        totalCount: 1,
        truncated: false,
      }),
    },
    held: held ? [AGENT_LIST] : [],
  });
}

// The worker's tree, on an Orca host with no workspace of this computer's.
const refresh = () => worker!.request('spyhop.tree') as Promise<TreeAnswer>;

// The next refresh, on the lists `agents` and `terminal` with the answer of `orca agent list`
// held back until `find` listed the session folder `sessions` over `ssh jeff`. Returns its tree
// and how often `find` listed that folder in it.
async function refreshWithListHeld(remoteHome: string, agents: object[], terminal: string, sessions: string) {
  const calls = jeffLists(remoteHome, agents, terminal, true);
  const finds = () => calls.ssh().filter(([alias, ...args]) => alias === 'jeff' && args.at(-1)!.startsWith(`'find' '${sessions}' `)).length;
  const answered = refresh();
  await calls.until(() => finds() > 0);
  calls.release(AGENT_LIST);
  return { tree: await answered, finds: finds() };
}

// The server's workspace rows of a tree, each its name and cards.
const workspacesOf = (tree: TreeAnswer) =>
  tree.hosts
    .find((host) => host.name === 'jeff')!
    .projects.flatMap((project) => project.workspaces)
    .map((row) => ({ name: row.name, cards: row.cards }));

test('Same list uses the cards built meanwhile', async () => {
  const home = useTempHome();
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'work/spyhop-main');
  const file = ompSession(remoteHome, folder);
  const listed = (state: string) => [serverAgent(folder, 'main', 'tab1:leaf2', { state, title: 'Fix the login bug' })];
  jeffLists(remoteHome, listed('working'), 'term-9');
  worker = await mountWorker(workerModule, { host: orcaHost(home, { workspaces: [] }) });
  const [{ cards: before }] = workspacesOf(await refresh());
  assert.deepEqual([before[0].groups[0].status.label, before[0].pane, costOf(before[0])], ['working', { environment: 'jeff', terminal: 'term-9' }, '$0.10']);
  appendFileSync(file, costTurn(0.15));

  const { tree, finds } = await refreshWithListHeld(remoteHome, listed('waiting'), 'term-12', dirname(file));

  // listed before the list answered (the answer was held until then), and not again after it
  assert.equal(finds, 1);
  const [{ cards }] = workspacesOf(tree);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].groups[0].status.label, 'waiting');
  assert.deepEqual(cards[0].pane, { environment: 'jeff', terminal: 'term-12' });
  assert.equal(costOf(cards[0]), '$0.25');
});

test('Changed list builds the cards again in the same refresh', async () => {
  const home = useTempHome();
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'work/spyhop-main');
  const file = ompSession(remoteHome, folder);
  const fixLogin = join(remoteHome, 'work/spyhop-fix-login');
  ompSession(remoteHome, fixLogin, 0.4);
  const main = serverAgent(folder, 'main', 'tab1:leaf2');
  jeffLists(remoteHome, [main], 'term-9');
  worker = await mountWorker(workerModule, { host: orcaHost(home, { workspaces: [] }) });
  assert.deepEqual(
    workspacesOf(await refresh()).map((row) => [row.name, row.cards.length]),
    [['main', 1]],
  );

  const { tree } = await refreshWithListHeld(remoteHome, [main, serverAgent(fixLogin, 'fix-login', 'tab2:leaf1')], 'term-9', dirname(file));

  const rows = workspacesOf(tree);
  assert.deepEqual(
    rows.map((row) => [row.name, row.cards.length]),
    [
      ['main', 1],
      ['fix-login', 1],
    ],
  );
  assert.equal(costOf(rows[1].cards[0]), '$0.40');
});
