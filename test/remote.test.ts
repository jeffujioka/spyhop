// Orca agents on other Orca hosts: on an SSH workspace, and on a paired Orca server, their
// harness sessions read over `ssh <alias>`. A test has no SSH host and no paired Orca server, so
// it stands in for those two programs only (test/helpers/stand-ins.ts): `orca` answers its list
// commands with recorded output shaped on this Mac's Orca, and `ssh` runs the command here under
// the remote host's own home folder, or fails as an unreachable host does. The tests check the
// calls both log. The worker is the real one; every other program it runs is real.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing';
import { createAgentCards } from '../src/agent-cards.ts';
import { GIT_TTL_MS } from '../src/core/git.js';
import { run } from '../src/exec.ts';
import { listHosts, remoteHosts } from '../src/hosts.ts';
import type { CardView as Card, TreeAnswer } from '../src/protocol.ts';
import * as workerModule from '../src/worker.ts';
import { NOW, agent, costOf, ompSessionOf as ompSession } from './helpers/agent-cards.ts';
import { useTempHome } from './helpers/env.ts';
import { tempHome } from './helpers/files.ts';
import { answer, standIns } from './helpers/stand-ins.ts';

let worker: TestWorker | undefined;
afterEach(async () => {
  await worker?.deactivate();
  worker = undefined;
});

// Orca's ids, as `orca host list` and `orca environment list` give them on this Mac.
const DEVBOX = 'ssh-1795031810693-d3v8ox';
const JEFF_TARGET = 'ssh-1795031810693-tsad3q';
const JEFF_ENV = 'dc9a64c1-6450-46a1-a62c-9b03d06b187a';

const hostList = answer({
  hosts: [
    { kind: 'local', name: 'this machine', id: 'local', selector: '--host local' },
    { kind: 'ssh', name: 'devbox', id: DEVBOX, selector: `--host ssh:${DEVBOX}`, connected: true },
    { kind: 'ssh', name: 'jeff', id: JEFF_TARGET, selector: `--host ssh:${JEFF_TARGET}`, connected: true },
    { kind: 'environment', name: 'jeff-server', id: JEFF_ENV },
  ],
});
const environmentList = answer({
  environments: [
    {
      id: JEFF_ENV,
      name: 'jeff-server',
      connectionDependency: 'ssh-tunnel',
      orcadDeployment: { sshTargetId: JEFF_TARGET, sshTargetGeneration: 8, localPort: 56082, remotePort: 6768 },
    },
  ],
});

// Whether one program with its arguments only reads.
function readsOnly([program, ...args]: string[]) {
  switch (program) {
    case 'cd':
    case 'uname':
    case 'printenv':
    case 'cat':
    case 'head':
    case 'tail':
    case 'stat':
    case '/usr/bin/stat':
      return true;
    case 'dd':
      return !args.some((arg) => arg.startsWith('of='));
    case 'find': {
      const exec = args.indexOf('-exec');
      return !args.some((arg) => ['-delete', '-execdir', '-ok', '-fprint'].includes(arg)) && (exec < 0 || readsOnly(args.slice(exec + 1, -2)));
    }
    case 'git':
      return (args[0] === 'branch' && args[1] === '--show-current') || (args[0] === 'remote' && args[1] === 'get-url');
    case 'sqlite3':
      return args[0] === '-readonly';
    default:
      return false;
  }
}

// Whether a command line `ssh` runs on the remote host is programs joined by `&&` that only
// read, every word of them quoted.
function readOnlyLine(line: string) {
  const words = line.match(/'[^']*'|&&/g) ?? [];
  if (words.join(' ') !== line) return false;
  const commands: string[][] = [[]];
  for (const word of words) {
    if (word === '&&') commands.push([]);
    else commands.at(-1)!.push(word.slice(1, -1));
  }
  return commands.every((command) => command.length > 0 && readsOnly(command));
}

// The cards under the rows `host`, `project` and `workspace`.
function cardsUnder(tree: TreeAnswer, host: string, project: string, workspace: string) {
  return tree.hosts
    .find((row) => row.name === host)
    ?.projects.find((row) => row.name === project)
    ?.workspaces.find((row) => row.name === workspace)?.cards;
}

// Every session figure of a card: the model, and each figure of the groups after the identity.
const sessionFigures = (card: Card) => [
  card.groups[0].model.value,
  ...card.groups.slice(1).flatMap((group) => [...(group.hero ? [group.hero.value] : []), ...group.figures.map((figure) => figure.value)]),
];

// An Orca workspace row of `workspace.list`, on the Orca host `hostId`.
const workspaceRow = (hostId: string, project: string, name: string, path: string) => ({
  id: `repo:${project}::${path}`,
  kind: 'worktree',
  name,
  project,
  projectId: `repo:${project}`,
  path,
  branch: name,
  hostId,
});
const ompAgent = (terminalId: string) => ({ terminalId, title: null, agent: 'omp', state: 'working', stateStartedAt: 0, sessionId: null });

// The worker on an Orca host with `rows`, each with one omp agent in `agents.list`, and the
// focused workspace `context` (`workspace.readContext`).
async function treeOf(rows: object[], context: object | null = null) {
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: rows, truncated: false },
      'agents.list': ({ workspaceId }: { workspaceId: string }) => ({ agents: [ompAgent(`${workspaceId}-t1`)] }),
      'workspace.readContext': context,
    },
  });
  worker = await mountWorker(workerModule, { host });
  return (await worker.request('spyhop.tree')) as TreeAnswer;
}

test('Agent on an SSH workspace', async () => {
  useTempHome();
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'work/infra-main');
  ompSession(remoteHome, folder);
  const calls = standIns({
    homes: { devbox: remoteHome },
    orca: { 'host list --json': hostList, 'environment list --json': answer({ environments: [] }) },
  });

  const tree = await treeOf([workspaceRow(`ssh:${DEVBOX}`, 'infra', 'main', folder)]);

  const [card] = cardsUnder(tree, 'devbox', 'infra', 'main') ?? [];
  assert.ok(card, JSON.stringify(tree.hosts.map((host) => host.name)));
  assert.equal(costOf(card), '$0.10');
  const ssh = calls.ssh();
  assert.ok(ssh.length > 0);
  assert.deepEqual(ssh.filter((args) => args[0] !== 'devbox' || !readOnlyLine(args.at(-1)!)), []);
  assert.deepEqual(calls.orca().filter((args) => !/^(host|environment) list --json$/.test(args)), []);
});

// The paired Orca server `jeff-server`, reached as `jeff`, with one omp agent in its workspace
// `main` of its project `spyhop`, whose session has logged 0.10 USD; and this computer's
// workspace `api`/`main` without one. Orca's `workspace.list` lists this computer's workspaces
// only: a paired server's are told of by its own `orca agent list`.
function pairedServer() {
  const home = useTempHome();
  const localFolder = join(home, 'work/api-main');
  mkdirSync(localFolder, { recursive: true });
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'work/spyhop-main');
  ompSession(remoteHome, folder);
  const worktreeId = `338dd6a3-d3c7-4e4e-a557-ccc460353d0f::${folder}`;
  // the server's own agents, local to it
  const agents = answer({
    agents: [
      {
        orcaSessionId: 'a9095501-0895-4c40-9e9c-216289f76d0d',
        kind: 'terminal',
        agent: 'omp',
        state: 'working',
        worktreeId,
        workspace: 'main',
        repo: 'spyhop',
        hostId: 'local',
        paneKey: '8a7ed8a4-6153-4090-bda7-3a43598521d0:31671951-71ba-455e-b380-50d484132d70',
        title: null,
        updatedAt: 1795513033225,
      },
    ],
    rest: { truncated: false, hostScope: { hostIds: ['local'], omittedHostIds: [] } },
  });
  const calls = standIns({
    homes: { jeff: remoteHome },
    orca: { 'host list --json': hostList, 'environment list --json': environmentList, 'agent list --environment jeff-server --json': agents },
  });
  return { rows: [workspaceRow('local', 'api', 'main', localFolder)], worktreeId, calls };
}

test('Agent on a paired Orca server', async () => {
  const { rows, calls } = pairedServer();

  const tree = await treeOf(rows);
  // a refresh within a minute lists the server's agents again, not the hosts
  await worker!.request('spyhop.tree');

  // a row per host: the server's agents do not join this computer's. The server's row is named
  // by its environment, and its sessions are read over its SSH target's alias.
  assert.deepEqual(
    tree.hosts.map((host) => host.name),
    ['local', 'jeff-server'],
  );
  assert.equal(new Set(tree.hosts.map((host) => host.id)).size, 2);
  const server = tree.hosts.find((host) => host.name === 'jeff-server');
  assert.deepEqual(
    server?.projects.map((project) => [project.name, project.workspaces.flatMap((row) => row.cards).length]),
    [['spyhop', 1]],
  );
  const [card] = cardsUnder(tree, 'jeff-server', 'spyhop', 'main') ?? [];
  assert.ok(card);
  assert.equal(costOf(card), '$0.10');
  const ssh = calls.ssh();
  assert.ok(ssh.length > 0);
  assert.deepEqual(ssh.filter((args) => args[0] !== 'jeff' || !readOnlyLine(args.at(-1)!)), []);
  assert.deepEqual(calls.orca().filter((args) => !/^((host|environment) list|agent list --environment jeff-server) --json$/.test(args)), []);
  assert.deepEqual(
    ['host list --json', 'environment list --json', 'agent list --environment jeff-server --json'].map(
      (line) => calls.orca().filter((args) => args === line).length,
    ),
    [1, 1, 2],
  );
});

test('Focused workspace on a paired Orca server', async () => {
  const { rows, worktreeId } = pairedServer();

  // Orca's id of a workspace is its worktreeId
  const tree = await treeOf(rows, { workspaceId: worktreeId, branch: 'main', displayName: 'main', terminals: [] });

  const workspace = tree.hosts
    .find((host) => host.name === 'jeff-server')
    ?.projects.find((project) => project.name === 'spyhop')
    ?.workspaces.find((row) => row.name === 'main');
  assert.ok(workspace, JSON.stringify(tree.hosts.map((host) => host.name)));
  assert.equal(tree.focused, workspace.id);
});

test('Host lists without hosts', async () => {
  standIns({ homes: {}, orca: { 'host list --json': answer({}), 'environment list --json': answer({}) } });

  const hosts = remoteHosts(await listHosts(run), [`ssh:${DEVBOX}`]);

  // the SSH host named by its id, and no paired server
  assert.deepEqual(Object.fromEntries(hosts), { [`ssh:${DEVBOX}`]: { name: DEVBOX, alias: DEVBOX } });
});

test('Unreachable Orca host', async () => {
  const home = useTempHome();
  const localFolder = join(home, 'work/api-main');
  ompSession(home, localFolder);
  const calls = standIns({
    homes: {},
    orca: { 'host list --json': hostList, 'environment list --json': answer({ environments: [] }) },
  });

  const tree = await treeOf([
    workspaceRow('local', 'api', 'main', localFolder),
    workspaceRow(`ssh:${DEVBOX}`, 'infra', 'main', '/home/dev/work/infra-main'),
  ]);

  const [remote] = cardsUnder(tree, 'devbox', 'infra', 'main') ?? [];
  assert.ok(remote);
  assert.deepEqual(
    sessionFigures(remote).filter((value) => value !== 'n/a'),
    [],
  );
  const [local] = cardsUnder(tree, 'local', 'api', 'main') ?? [];
  assert.equal(costOf(local), '$0.10');
  assert.ok(calls.ssh().length > 0);
});

test('No git read on a host whose place lookup failed', async () => {
  const calls = standIns({ homes: {}, orca: {} });
  const folders = ['a', 'b', 'c'].map((name) => `/home/dev/work/${name}`);

  await createAgentCards({ run, home: tempHome() }).build(
    folders.map((path, i) => agent({ id: `t${i}`, agent: 'omp', path, machine: 'gone' })),
    NOW,
  );

  // only the place lookup: `uname -s` and `printenv HOME`, each once
  assert.deepEqual(calls.ssh().map((args) => args.at(-1)).sort(), ["'printenv' 'HOME'", "'uname' '-s'"]);
});

test('A host that stops answering costs one place lookup', async () => {
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'work/api-main');
  ompSession(remoteHome, folder);
  standIns({ homes: { box: remoteHome }, orca: {} });
  // one builder over refreshes, as the worker keeps it
  const cards = createAgentCards({ run, home: tempHome() });
  const agents = [agent({ agent: 'omp', path: folder, machine: 'box' })];
  // the host answers: its session is read
  assert.equal((await cards.build(agents, NOW))[0].stats.costUsd, 0.1);

  // the host goes down: its commands exit 255, as ssh does when it cannot connect
  standIns({ homes: {}, orca: {} });
  await cards.build(agents, NOW + GIT_TTL_MS);
  const down = standIns({ homes: {}, orca: {} });
  await cards.build(agents, NOW + 2 * GIT_TTL_MS);

  // only the place lookup: `uname -s` and `printenv HOME`, each once
  assert.deepEqual(down.ssh().map((args) => args.at(-1)).sort(), ["'printenv' 'HOME'", "'uname' '-s'"]);
});
