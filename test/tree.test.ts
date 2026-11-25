// The tree of the cards: Orca host → Orca project → Orca workspace, with the Totals of cost,
// tokens and premium requests on the project and workspace rows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStats } from '../src/core/providers/index.js';
import { buildTree, type TreeAgent } from '../src/tree.ts';

// A card in the card builder's shape (src/agent-cards.ts), every other figure n/a.
const card = (id: string, figures: Record<string, number | string>, status = 'done') => ({
  id,
  folder: '/work/app',
  status,
  stats: { ...readStats('', null, 0), ...figures },
});

// Two Orca agents of the Orca workspace `main`, the only one of the Orca project `app`.
const AGENTS: TreeAgent[] = [
  { id: 'a1', hostId: 'local', repo: 'app', workspace: 'main', worktreeId: 'w1::/work/app' },
  { id: 'a2', hostId: 'local', repo: 'app', workspace: 'main', worktreeId: 'w1::/work/app' },
];

test('Totals add up', () => {
  const cards = [
    card('a1', { costUsd: 1.2, totalTokens: 10000, premiumRequests: 2 }),
    card('a2', { costUsd: 0.3, totalTokens: 5000, premiumRequests: 1 }),
  ];
  const [host, ...otherHosts] = buildTree(AGENTS, cards);
  assert.deepEqual(otherHosts, []);
  assert.equal(host.name, 'local');
  const [project] = host.projects;
  const [main] = project.workspaces;
  assert.equal(project.name, 'app');
  assert.equal(main.name, 'main');
  assert.deepEqual(main.cards, cards);
  // the Totals, and no context, cache or activity figure
  const totals = { cost: '$1.50', tokens: '15k', premium: '3' };
  assert.deepEqual(main.totals, totals);
  assert.deepEqual(project.totals, totals);
});

test('One card without the figure', () => {
  const cards = [
    card('a1', { costUsd: 1.2, totalTokens: 10000, premiumRequests: 2 }),
    card('a2', { costUsd: 0.3, totalTokens: 5000 }),
  ];
  const [main] = buildTree(AGENTS, cards)[0].projects[0].workspaces;
  assert.equal(main.totals.cost, '$1.50');
  assert.equal(main.totals.premium, 'n/a');
});

test('two projects with the same name on one host stay two rows', () => {
  const agents: TreeAgent[] = [
    { id: 'a1', hostId: 'local', repo: 'app', workspace: 'main', worktreeId: 'w1::/work/app' },
    { id: 'a2', hostId: 'local', repo: 'app', workspace: 'main', worktreeId: 'w2::/other/app' },
  ];
  const cards = [card('a1', { costUsd: 1.2 }), card('a2', { costUsd: 0.3 })];
  const [host] = buildTree(agents, cards);
  assert.deepEqual(
    host.projects.map((project) => [project.name, project.totals.cost, project.workspaces.map((row) => row.cards.map((c) => c.id))]),
    [
      ['app', '$1.20', [['a1']]],
      ['app', '$0.30', [['a2']]],
    ],
  );
});

test('a worktreeId without a project id keys its project by name', () => {
  const agents: TreeAgent[] = [
    { id: 'a1', hostId: 'local', repo: 'app', workspace: 'main', worktreeId: '/work/app' },
    { id: 'a2', hostId: 'local', repo: 'app', workspace: 'fix', worktreeId: '/work/app-fix' },
  ];
  const [host] = buildTree(agents, [card('a1', {}), card('a2', {})]);
  assert.deepEqual(
    host.projects.map((project) => [project.name, project.workspaces.map((row) => row.name)]),
    [['app', ['main', 'fix']]],
  );
});

test('Cards ordered by Orca state', () => {
  const states = { a: 'done', b: 'waiting', c: 'working', d: 'blocked', e: 'working' };
  const ids = Object.keys(states) as (keyof typeof states)[];
  const agents: TreeAgent[] = ids.map((id) => ({ id, hostId: 'local', repo: 'app', workspace: 'main', worktreeId: 'w1::/work/app' }));
  const [main] = buildTree(agents, ids.map((id) => card(id, {}, states[id])))[0].projects[0].workspaces;
  assert.deepEqual(main.cards.map((c) => c.id), ['c', 'e', 'd', 'b', 'a']);
});

test('Cards of a state Orca does not name go last', () => {
  const states = { a: 'idle', b: 'done', c: 'working', d: 'paused' };
  const ids = Object.keys(states) as (keyof typeof states)[];
  const agents: TreeAgent[] = ids.map((id) => ({ id, hostId: 'local', repo: 'app', workspace: 'main', worktreeId: 'w1::/work/app' }));
  const [main] = buildTree(agents, ids.map((id) => card(id, {}, states[id])))[0].projects[0].workspaces;
  assert.deepEqual(main.cards.map((c) => c.id), ['c', 'b', 'a', 'd']);
});
