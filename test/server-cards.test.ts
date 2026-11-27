// A paired Orca server's cards while its lists load: a refresh builds the cards of the agents the
// server listed at the previous refresh while `orca agent list --environment` and `orca terminal
// list --environment` run, uses them when the new list names the same agents, with each agent's
// state, the time it entered it and its pane from the new list, and builds the cards again when it
// differs. The worker is the
// real one; the `orca` CLI and `ssh`, stood in for (test/helpers/stand-ins.ts), play the paired
// server `jeff`, read over `ssh jeff`, and log their calls. Each refresh has its own stand-ins,
// so its own answers and call log; the second one's `orca agent list` answer is held back until
// the session folder was listed over ssh.
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mock } from 'node:test';
import { afterEach, assert, mountWorker, test, type TestWorker } from 'orca/testing';
import type { CardView, FleetAnswer } from '../src/protocol.ts';
import * as workerModule from '../src/worker.ts';
import { NOW, costOf, costTurn, ompSessionOf as ompSession } from './helpers/agent-cards.ts';
import { useTempHome } from './helpers/env.ts';
import { tempHome } from './helpers/files.ts';
import { JEFF_AGENT_LIST as AGENT_LIST, JEFF_LISTS, JEFF_TERMINAL_LIST } from './helpers/orca-answers.ts';
import { orcaHost } from './helpers/orca-host.ts';
import { serverAgent } from './helpers/server-agent.ts';
import { answer, standIns } from './helpers/stand-ins.ts';

let worker: TestWorker | undefined;
afterEach(async () => {
  await worker?.deactivate();
  worker = undefined;
  mock.timers.reset();
});

// The stand-ins of one refresh: the paired server `jeff`, whose home folder is `remoteHome`,
// lists `agents`, and its terminal `terminal` in the tab `tab1` and its leaf `leaf2`; `held`:
// the answer to `orca agent list` is held back until released.
function jeffLists(remoteHome: string, agents: object[], terminal: string, held = false) {
  return standIns({
    homes: { jeff: remoteHome },
    orca: {
      ...JEFF_LISTS,
      [AGENT_LIST]: answer({ agents }),
      [JEFF_TERMINAL_LIST]: answer({
        terminals: [{ handle: terminal, ptyId: 'pty-1', orphaned: false, tabId: 'tab1', leafId: 'leaf2', title: 'omp', connected: true }],
        totalCount: 1,
        truncated: false,
      }),
    },
    held: held ? [AGENT_LIST] : [],
  });
}

// The worker's fleet, on an Orca host with no workspace of this computer's.
const refresh = () => worker!.request('spyhop.fleet', { request: 1 }) as Promise<FleetAnswer>;

// The next refresh, on the lists `agents` and `terminal` with the answer of `orca agent list`
// held back until `find` listed omp's session folders, which `sessions` holds, over `ssh jeff`.
// Returns its fleet and how often `find` listed them in it.
async function refreshWithListHeld(remoteHome: string, agents: object[], terminal: string, sessions: string) {
  const calls = jeffLists(remoteHome, agents, terminal, true);
  const finds = () => calls.ssh().filter(([alias, ...args]) => alias === 'jeff' && args.at(-1)!.startsWith(`'find' '-H' '${sessions}' `)).length;
  const answered = refresh();
  await calls.until(() => finds() > 0);
  calls.release(AGENT_LIST);
  return { fleet: await answered, finds: finds() };
}

// The cards of the server's group of a fleet.
const serverCardsOf = (fleet: FleetAnswer): CardView[] => fleet.groups.find((group) => group.name === 'jeff')!.cards;

test('Same list uses the cards built meanwhile', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const home = useTempHome();
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'work/spyhop-main');
  const file = ompSession(remoteHome, folder, 0.1, 'Fix the login bug');
  // the agent in the state `state`, which it entered `since` ms before NOW
  const listed = (state: string, since: number) => [
    { ...serverAgent(folder, 'main', 'tab1:leaf2', { state, title: 'Fix the login bug' }), updatedAt: NOW - since },
  ];
  jeffLists(remoteHome, listed('working', 60_000), 'term-9');
  worker = await mountWorker(workerModule, { host: orcaHost(home, { workspaces: [] }) });
  const before = serverCardsOf(await refresh());
  assert.deepEqual([before[0].state, before[0].pane, costOf(before[0])], ['working', { environment: 'jeff', terminal: 'term-9' }, '$0.10']);
  appendFileSync(file, costTurn(0.15));

  const { fleet, finds } = await refreshWithListHeld(remoteHome, listed('waiting', 5_000), 'term-12', dirname(dirname(file)));

  // listed before the list answered (the answer was held until then), and not again after it
  assert.equal(finds, 1);
  const cards = serverCardsOf(fleet);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].state, 'waiting');
  assert.equal(cards[0].stateSinceMs, 5_000);
  assert.deepEqual(cards[0].pane, { environment: 'jeff', terminal: 'term-12' });
  assert.equal(costOf(cards[0]), '$0.25');
});

// A guard of the worker's fast path, no scenario of the spec: Orca's title of a working omp agent
// carries a spinner frame that changes every 100 ms, which is no change of the listed agents.
test('A spinner frame in the title is the same list', async () => {
  const home = useTempHome();
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'work/boto');
  const file = ompSession(remoteHome, folder, 0.1, 'Add quadrant mode');
  const listed = (title: string) => [serverAgent(folder, 'main', 'tab1:leaf2', { title })];
  jeffLists(remoteHome, listed('π ⠋ Add quadrant mode - boto'), 'term-9');
  worker = await mountWorker(workerModule, { host: orcaHost(home, { workspaces: [] }) });
  assert.equal(costOf(serverCardsOf(await refresh())[0]), '$0.10');

  const { fleet, finds } = await refreshWithListHeld(remoteHome, listed('π ⠙ Add quadrant mode - boto'), 'term-9', dirname(dirname(file)));

  // listed before the list answered, and not again after it: the cards built meanwhile are used
  assert.equal(finds, 1);
  assert.equal(serverCardsOf(fleet)[0].title, 'Add quadrant mode');
});

test('Changed list builds the cards again in the same refresh', async () => {
  const home = useTempHome();
  const remoteHome = tempHome();
  const folder = join(remoteHome, 'work/spyhop-main');
  const file = ompSession(remoteHome, folder, 0.1, 'Fix the login bug');
  const fixLogin = join(remoteHome, 'work/spyhop-fix-login');
  ompSession(remoteHome, fixLogin, 0.4, 'Write the docs');
  const main = serverAgent(folder, 'main', 'tab1:leaf2', { title: 'Fix the login bug' });
  jeffLists(remoteHome, [main], 'term-9');
  worker = await mountWorker(workerModule, { host: orcaHost(home, { workspaces: [] }) });
  assert.equal(serverCardsOf(await refresh()).length, 1);

  const fixer = serverAgent(fixLogin, 'fix-login', 'tab2:leaf1', { title: 'Write the docs' });
  const { fleet } = await refreshWithListHeld(remoteHome, [main, fixer], 'term-9', dirname(dirname(file)));

  const cards = serverCardsOf(fleet);
  assert.equal(cards.length, 2);
  assert.equal(costOf(cards[1]), '$0.40');
});
