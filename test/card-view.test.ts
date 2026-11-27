// A built card as the panel draws it (src/card-view.ts), and the cards of a fleet in their Orca
// hosts' groups (src/fleet.ts): pure, over built cards and agents written here, with no I/O.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BuiltCard } from '../src/agent-cards.ts';
import { cardView } from '../src/card-view.ts';
import { NA, readStats } from '../src/core/providers/index.js';
import { groupCards, stateCounts, withGroup, type FleetAgent } from '../src/fleet.ts';
import type { HostGroup } from '../src/protocol.ts';

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const HOME = '/Users/me';

// A built card of a working omp agent of the folder ~/work/boto, every figure n/a but `stats`.
const built = (fields: Partial<BuiltCard> = {}, stats: Record<string, unknown> = {}): BuiltCard => ({
  id: 't1',
  folder: `${HOME}/work/boto`,
  branch: 'feat/jaci',
  origin: null,
  harness: 'omp',
  harnessName: 'omp',
  title: null,
  status: 'working',
  machine: null,
  stateSince: null,
  ...fields,
  stats: { ...readStats('', null, 0), ...stats } as BuiltCard['stats'],
});

const viewOf = (card: BuiltCard) => cardView(card, { home: HOME, pane: null, now: NOW });

// An Orca agent of the Orca host `hostId`, in Orca's state `state`.
const fleetAgent = (id: string, hostId: string, state: string): FleetAgent =>
  ({ id, agent: 'omp', state, title: null, path: null, hostId, workspaceId: `${hostId}:w` }) as FleetAgent;

// The view of the card of each agent, with the agent's state.
const viewsOf = (agents: FleetAgent[]) => agents.map((agent) => viewOf(built({ id: agent.id, status: agent.state })));

test("a card's spark is its session's recent contexts", () => {
  const card = built(
    { title: 'π > Write the docs', stateSince: NOW - 60000 },
    { model: 'claude-opus-5.5-1m', costUsd: 16.05, contextTokens: 300, contextMax: 1000, contextPercent: 0.3, headroomTokens: 200, cacheHitRate: 0.9, detail: { recent: [100, 200, 300] } },
  );
  assert.deepEqual(cardView(card, { home: HOME, pane: { terminalId: 'term-1' }, now: NOW }), {
    id: 't1',
    state: 'working',
    stateSinceMs: 60000,
    title: 'Write the docs',
    folder: 'boto',
    branch: 'feat/jaci',
    harness: 'omp',
    model: 'claude-opus-5.5-1m',
    cost: 16.05,
    reading: null,
    context: { tokens: 300, window: 1000, percent: 0.3, compactAt: 0.5, spark: [100, 200, 300] },
    tokensLeft: 200,
    cacheHitRate: 0.9,
    subAgents: null,
    burnPerHour: NA,
    pane: { terminalId: 'term-1' },
  });
  // a session not read whole has no recent contexts, and an untitled one is named by its folder
  const unread = viewOf(built({ branch: null }));
  assert.deepEqual(unread.context.spark, []);
  assert.equal(unread.title, 'boto');
  assert.equal(unread.branch, null);
});

test('the compaction mark is the trigger over the window', () => {
  const omp = { contextTokens: 620000, contextMax: 1000000, contextPercent: 0.62 };
  const known = viewOf(built({}, { ...omp, headroomTokens: 230000 })).context;
  assert.equal(known.compactAt, 0.85);
  assert.equal(known.percent, 0.62);
  const spent = viewOf(built({}, { ...omp, headroomTokens: 0 })).context;
  assert.equal(spent.compactAt, spent.percent);
  // a trigger past the window marks the window's end
  assert.equal(viewOf(built({}, { ...omp, headroomTokens: 900000 })).context.compactAt, 1);
  assert.equal(viewOf(built({}, omp)).context.compactAt, NA);
});

test('a state Orca gives no start for reads n/a', () => {
  assert.equal(viewOf(built({ stateSince: null })).stateSinceMs, NA);
  assert.equal(viewOf(built({ stateSince: NOW - 180000 })).stateSinceMs, 180000);
});

test("groups put this computer first, then Orca's order", () => {
  const agents = [fleetAgent('r1', 'ssh:devbox', 'working'), fleetAgent('l1', 'local', 'working'), fleetAgent('l2', 'local', 'working')];
  const groups = groupCards(agents, viewsOf(agents), new Map([['ssh:devbox', 'devbox']]));
  assert.deepEqual(
    groups.map(({ id, name, count, cards }) => ({ id, name, count, cards: cards.map((card) => card.id) })),
    [
      { id: 'local', name: 'local', count: 2, cards: ['l1', 'l2'] },
      { id: 'ssh:devbox', name: 'devbox', count: 1, cards: ['r1'] },
    ],
  );
});

test("a group's cards go blocked, waiting, working, done, then any other state", () => {
  const agents = [
    fleetAgent('a', 'local', 'done'),
    fleetAgent('f', 'local', 'idle'),
    fleetAgent('b', 'local', 'waiting'),
    fleetAgent('c', 'local', 'working'),
    fleetAgent('d', 'local', 'blocked'),
    fleetAgent('e', 'local', 'working'),
  ];
  // agent `g` shares the card of `c`, so it has no card of its own
  const [group] = groupCards([...agents, fleetAgent('g', 'local', 'working')], viewsOf(agents), new Map());
  assert.deepEqual(group.cards.map((card) => card.id), ['d', 'b', 'c', 'e', 'a', 'f']);
  assert.equal(group.count, 6);
});

test('a later group of a host replaces the one drawn', () => {
  const group = (id: string, count: number): HostGroup => ({ id, name: id, count, cards: [] });
  const drawn = [group('local', 1), group('ssh:devbox', 1)];
  assert.deepEqual(withGroup(drawn, group('local', 2)), [group('local', 2), group('ssh:devbox', 1)]);
  assert.deepEqual(withGroup(drawn, group('ssh:jeff', 3)), [...drawn, group('ssh:jeff', 3)]);
});

test('counts leave out a state no agent is in', () => {
  const agents = [fleetAgent('a', 'local', 'working'), fleetAgent('b', 'ssh:devbox', 'done'), fleetAgent('c', 'local', 'working')];
  assert.deepEqual(stateCounts(agents), { working: 2, done: 1 });
});
