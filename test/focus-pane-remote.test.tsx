// A card's Focus pane button for an Orca agent of a paired Orca server: pressing it runs
// `orca terminal switch` for the server's terminal of the agent's pane, and runs nothing over
// ssh; a card whose agent has no pane shows no button; a switch that fails changes nothing in the
// panel and lands in the worker's log. The worker and panel are the real ones; the `orca` CLI and
// `ssh`, stood in for (test/helpers/stand-ins.ts), play the paired server `jeff` and log their
// calls. The clock is node:test's mock clock, which no test moves: the panel asks for its tree
// once, so the calls after a press are the press's own.
import { mock } from 'node:test';
import { afterEach, assert, mount, mountWorker, test, type TestPanel, type TestWorker } from 'orca/testing';
import * as panelModule from '../src/panel.tsx';
import type { TreeAnswer } from '../src/protocol.ts';
import * as workerModule from '../src/worker.ts';
import { useTempHome } from './helpers/env.ts';
import { tempHome } from './helpers/files.ts';
import { JEFF_AGENT_LIST, JEFF_LISTS, JEFF_TERMINAL_LIST } from './helpers/orca-answers.ts';
import { orcaHost, type HostWorkspace } from './helpers/orca-host.ts';
import { serverAgent } from './helpers/server-agent.ts';
import { answer, standIns } from './helpers/stand-ins.ts';

let panel: TestPanel | undefined;
let worker: TestWorker | undefined;
afterEach(async () => {
  await panel?.unmount();
  await worker?.deactivate();
  panel = undefined;
  worker = undefined;
  mock.timers.reset();
});

const SWITCH = 'terminal switch --environment jeff --terminal term-9 --json';

// The server's omp Orca agents: the one of its workspace `main`, in the pane of `term-9`, and
// the one of its workspace `lost`, in a pane no listed terminal is in.
const MAIN = serverAgent('/home/jeff/work/spyhop-main', 'main', 'tab1:leaf2');
const LOST = serverAgent('/home/jeff/work/spyhop-lost', 'lost', 'tab7:leaf7');

// The server's terminal `term-9`, in the tab `tab1` and its leaf `leaf2`.
const terminals = answer({
  terminals: [
    { handle: 'term-9', ptyId: 'pty-9', orphaned: false, worktreeId: 'repo-spyhop::/home/jeff/work/spyhop-main', tabId: 'tab1', leafId: 'leaf2', title: 'omp', connected: true },
  ],
  totalCount: 1,
  truncated: false,
});

// Opens the panel, with its worker, on this computer's Orca workspaces `workspaces` and the
// paired server `jeff` with the agents `agents`; `orca` adds commands the CLI answers.
async function openPanel(agents: object[], workspaces: HostWorkspace[] = [], orca: Record<string, string> = {}) {
  const home = useTempHome();
  const calls = standIns({
    homes: { jeff: tempHome() },
    orca: {
      ...JEFF_LISTS,
      [JEFF_AGENT_LIST]: answer({ agents }),
      [JEFF_TERMINAL_LIST]: terminals,
      ...orca,
    },
  });
  const host = orcaHost(home, { workspaces });
  mock.timers.enable({ apis: ['setTimeout'] });
  worker = await mountWorker(workerModule, { host });
  panel = await mount(panelModule, { host });
  // no workspace is focused: the developer opens every row
  for (let closed = closedRow(); closed; closed = closedRow()) await panel.toggle(closed);
  return { calls, host };
}

const closedRow = () => panel!.findAll({ type: 'Collapsible' }).find((row) => row.props.open === false);

const focusButtons = () => panel!.findAll({ type: 'Button', text: 'Focus pane' });

// What `orca terminal switch --environment jeff` answers: `navigated` false when no desktop here
// shows the server.
const switched = (navigated: boolean) => answer({ focus: { handle: 'term-9', tabId: 'tab1', navigated } });

test('Focus pane on a paired Orca server', async () => {
  const { calls, host } = await openPanel([MAIN], [], { [SWITCH]: switched(true) });
  const [button] = focusButtons();
  assert.ok(button, JSON.stringify(panel!.tree()));
  const [ssh, orca] = [calls.ssh().length, calls.orca().length];

  await panel!.press(button);

  assert.deepEqual(panel!.errors, []);
  assert.deepEqual(worker!.refusals, []);
  assert.deepEqual(calls.orca().slice(orca), [SWITCH]);
  assert.deepEqual(calls.ssh().slice(ssh), []);
  assert.deepEqual(host.callsOf('terminal.focus'), []);
  assert.deepEqual(worker!.logs, []);
});

test('Card without a pane', async () => {
  // a local agent in a chat, an agent of the server whose pane no listed terminal is in, and,
  // to show a matched pane still draws its button, one whose pane is `term-9`'s
  await openPanel(
    [LOST, MAIN],
    [{ project: 'api', name: 'chat', agents: ['working'], terminals: [null] }],
  );

  const tree = (await worker!.request('spyhop.tree')) as TreeAnswer;
  const panes = Object.fromEntries(
    tree.hosts.flatMap((host) =>
      host.projects.flatMap((project) => project.workspaces.map((workspace) => [`${host.name}/${workspace.name}`, workspace.cards.map((card) => card.pane)])),
    ),
  );
  assert.deepEqual(panes, {
    'local/chat': [null],
    'jeff/lost': [null],
    'jeff/main': [{ environment: 'jeff', terminal: 'term-9' }],
  });
  assert.equal(panel!.findAll({ type: 'Card' }).length, 3, JSON.stringify(panel!.tree()));
  assert.equal(focusButtons().length, 1);
});

test('Paired server cannot switch', async () => {
  // the stand-in answers no `terminal switch`: it fails as the CLI does
  const { calls } = await openPanel([MAIN]);
  const [button] = focusButtons();
  assert.ok(button, JSON.stringify(panel!.tree()));
  const before = JSON.stringify(panel!.tree());
  const ssh = calls.ssh().length;

  await panel!.press(button);

  assert.deepEqual(panel!.errors, []);
  assert.equal(JSON.stringify(panel!.tree()), before);
  assert.ok(calls.orca().includes(SWITCH));
  assert.deepEqual(calls.ssh().slice(ssh), []);
  const logged = worker!.logs.filter((line) => line.includes('term-9'));
  assert.equal(logged.length, 1, JSON.stringify(worker!.logs));
  assert.match(logged[0], /not_found/);
});

test('Paired server no desktop here shows', async () => {
  const { calls } = await openPanel([MAIN], [], { [SWITCH]: switched(false) });
  const [button] = focusButtons();
  assert.ok(button, JSON.stringify(panel!.tree()));
  const before = JSON.stringify(panel!.tree());

  await panel!.press(button);

  assert.deepEqual(panel!.errors, []);
  assert.equal(JSON.stringify(panel!.tree()), before);
  assert.ok(calls.orca().includes(SWITCH));
  assert.deepEqual(await worker!.request('spyhop.focus', { environment: 'jeff', terminal: 'term-9' }), { focused: false });
  const logged = worker!.logs.filter((line) => line.includes('term-9'));
  assert.equal(logged.length, 2, JSON.stringify(worker!.logs));
  assert.match(logged[0], /navigated: false|did not navigate/);
});

test('Truncated terminal list of a paired server is logged', async () => {
  await openPanel([MAIN], [], {
    [JEFF_TERMINAL_LIST]: answer({ ...JSON.parse(terminals).result, totalCount: 201, truncated: true }),
  });

  // the listed terminals still give their panes
  assert.equal(focusButtons().length, 1);
  const logged = worker!.logs.filter((line) => line.includes('jeff'));
  assert.ok(logged.length > 0, JSON.stringify(worker!.logs));
  assert.match(logged[0], /1 of 201 terminals/);
});

test('Paired server switch that answers no focus', async () => {
  await openPanel([MAIN], [], { [SWITCH]: answer({}) });

  assert.deepEqual(await worker!.request('spyhop.focus', { environment: 'jeff', terminal: 'term-9' }), { focused: false });
  const logged = worker!.logs.filter((line) => line.includes('term-9'));
  assert.equal(logged.length, 1, JSON.stringify(worker!.logs));
});

test('Focus press the worker cannot answer changes nothing', async () => {
  await openPanel([MAIN], [], { [SWITCH]: switched(true) });
  const [button] = focusButtons();
  assert.ok(button, JSON.stringify(panel!.tree()));
  const before = JSON.stringify(panel!.tree());
  // the worker is gone: the panel's request rejects
  await worker!.deactivate();
  worker = undefined;

  await panel!.press(button);

  assert.deepEqual(panel!.errors, []);
  assert.equal(JSON.stringify(panel!.tree()), before);
});
