// Orca agents on other Orca hosts: on an SSH workspace, and on a paired Orca server, their
// harness sessions read over `ssh <alias>`. A test has no SSH host and no paired Orca server, so
// it stands in for those two programs only (test/helpers/stand-ins.ts): `orca` answers its list
// commands with recorded output shaped on this Mac's Orca, and `ssh` runs the command here under
// the remote host's own home folder, or fails as an unreachable host does. The tests check the
// calls both log. The worker is the real one; every other program it runs is real.
import { execFileSync } from 'node:child_process';
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
import { recordingRun } from './core/helpers/recording-run.ts';
import { DEVBOX, DEVBOX_HOST, JEFF_ENV, JEFF_SERVER_ENVIRONMENTS, JEFF_TARGET, LOCAL_HOST, environmentListOf, hostListOf } from './helpers/orca-answers.ts';
import { answer, standIns } from './helpers/stand-ins.ts';

let worker: TestWorker | undefined;
afterEach(async () => {
  await worker?.deactivate();
  worker = undefined;
});

// `orca host list` with the SSH targets `devbox` and `jeff`, and the paired server
// `jeff-server`.
const hostList = hostListOf(
  LOCAL_HOST,
  DEVBOX_HOST,
  { kind: 'ssh', name: 'jeff', id: JEFF_TARGET, selector: `--host ssh:${JEFF_TARGET}`, connected: true },
  { kind: 'environment', name: 'jeff-server', id: JEFF_ENV },
);

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
// An omp agent as `agents.list` gives one, its sessionId that of the helper's omp session.
const ompAgent = (terminalId: string) => ({ terminalId, title: null, agent: 'omp', state: 'working', stateStartedAt: 0, sessionId: 's1' });

// The worker on an Orca host with `rows`, each with one omp agent in `agents.list`, which
// `agent` changes, and the focused workspace `context` (`workspace.readContext`).
async function treeOf(rows: object[], context: object | null = null, agent: object = {}) {
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: rows, truncated: false },
      'agents.list': ({ workspaceId }: { workspaceId: string }) => ({ agents: [{ ...ompAgent(`${workspaceId}-t1`), ...agent }] }),
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
  // `devbox` does not reuse connections itself, as `ssh -G jeff` prints on this Mac
  const calls = standIns({
    homes: { devbox: remoteHome },
    orca: { 'host list --json': hostList, 'environment list --json': environmentListOf() },
    controlmaster: { devbox: 'false' },
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

test('Session of a sub-folder on an SSH workspace', async () => {
  useTempHome();
  const remoteHome = tempHome();
  // the workspace folder is no git repository; omp ran in its sub-folder, which is one
  const folder = join(remoteHome, 'work/infra-main');
  const tools = join(folder, 'tools');
  ompSession(remoteHome, tools, 0.1, 'Ship the deploy script');
  execFileSync('git', ['init', '-q', '-b', 'feat/deploy'], { cwd: tools });
  const calls = standIns({
    homes: { devbox: remoteHome },
    orca: { 'host list --json': hostList, 'environment list --json': environmentListOf() },
    controlmaster: { devbox: 'false' },
  });

  const row = workspaceRow(`ssh:${DEVBOX}`, 'infra', 'main', folder);
  const tree = await treeOf([row], null, { title: 'π - Ship the deploy script - tools', sessionId: null });

  const [card] = cardsUnder(tree, 'devbox', 'infra', 'main') ?? [];
  assert.ok(card, JSON.stringify(tree.hosts.map((host) => host.name)));
  const [identity] = card.groups;
  assert.deepEqual([costOf(card), identity.path.value, identity.branch], ['$0.10', tools, 'feat/deploy']);
  const ssh = calls.ssh();
  assert.ok(ssh.length > 0);
  assert.deepEqual(ssh.filter((args) => args[0] !== 'devbox' || !readOnlyLine(args.at(-1)!)), []);
});

// The paired Orca server `jeff-server`, reached as `jeff`, with one omp agent in its workspace
// `main` of its project `spyhop`, whose session, titled as the agent's title says, has logged
// 0.10 USD; and this computer's workspace `api`/`main` without one. Orca's `workspace.list`
// lists this computer's workspaces only: a paired server's are told of by its own
// `orca agent list`.
function pairedServer(orca: Record<string, string> = {}) {
  const home = useTempHome();
  const localFolder = join(home, 'work/api-main');
  mkdirSync(localFolder, { recursive: true });
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'work/spyhop-main');
  ompSession(remoteHome, folder, 0.1, 'Fix the login bug');
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
        title: 'π - Fix the login bug',
        updatedAt: 1795513033225,
      },
    ],
    rest: { truncated: false, hostScope: { hostIds: ['local'], omittedHostIds: [] } },
  });
  const calls = standIns({
    homes: { jeff: remoteHome },
    orca: {
      'host list --json': hostList,
      'environment list --json': JEFF_SERVER_ENVIRONMENTS,
      'agent list --environment jeff-server --json': agents,
      'terminal list --environment jeff-server --json': answer({ terminals: [], totalCount: 0, truncated: false }),
      ...orca,
    },
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
  assert.deepEqual(calls.orca().filter((args) => !/^((host|environment) list|(agent|terminal) list --environment jeff-server) --json$/.test(args)), []);
  // and one terminal list of the server per refresh, for the panes of its agents
  assert.deepEqual(
    ['host list --json', 'environment list --json', 'agent list --environment jeff-server --json', 'terminal list --environment jeff-server --json'].map(
      (line) => calls.orca().filter((args) => args === line).length,
    ),
    [1, 1, 2, 2],
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
  // the worker names Orca's id of the focused workspace, by which the panel finds its row
  assert.equal(tree.focused, worktreeId);
  assert.ok(workspace.workspaceIds.includes(worktreeId), JSON.stringify(workspace.workspaceIds));
});

// A paired server that answers its lists with no result, or with a null agent, still leaves the
// tree drawn: this computer's cards, and the server's agents when only its terminals are odd.
for (const [what, orca, serverCards] of [
  ['terminal list answers no result', { 'terminal list --environment jeff-server --json': answer(null) }, 1],
  ['agent list answers no result', { 'agent list --environment jeff-server --json': answer(null) }, 0],
  ['agent list answers a null agent', { 'agent list --environment jeff-server --json': answer({ agents: [null] }) }, 0],
] as const) {
  test(`Paired server whose ${what}`, async () => {
    const { rows } = pairedServer(orca);

    const tree = await treeOf(rows);

    assert.equal(cardsUnder(tree, 'local', 'api', 'main')?.length, 1, JSON.stringify(tree.hosts.map((host) => host.name)));
    assert.equal(cardsUnder(tree, 'jeff-server', 'spyhop', 'main')?.length ?? 0, serverCards);
  });
}

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
    orca: { 'host list --json': hostList, 'environment list --json': environmentListOf() },
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

test('A dead host whose agents have no session to read costs one place lookup', async () => {
  standIns({ homes: {}, orca: {} });
  // the runner's calls as they start: the second build waits for no lookup it starts
  const { exec, calls } = recordingRun();
  // one builder over refreshes, as the worker keeps it
  const cards = createAgentCards({ run: exec, home: tempHome() });
  const agents = [agent({ agent: 'codex', path: '/home/dev/work/a', machine: 'gone' })];

  await cards.build(agents, NOW);
  await cards.build(agents, NOW + 1);

  // the place is asked where git is read, whose answer is kept for GIT_TTL_MS
  assert.deepEqual(calls.map(({ command }) => command).sort(), ['printenv', 'uname']);
});

test('A host that stops answering costs one place lookup', async () => {
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'work/api-main');
  ompSession(remoteHome, folder);
  standIns({ homes: { box: remoteHome }, orca: {} });
  // one builder over refreshes, as the worker keeps it
  const cards = createAgentCards({ run, home: tempHome() });
  const agents = [agent({ agent: 'omp', sessionId: 's1', path: folder, machine: 'box' })];
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
