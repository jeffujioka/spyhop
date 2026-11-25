// The tree of the cards: Orca host → Orca project → Orca workspace, with the Totals of cost,
// tokens and premium requests on the project and workspace rows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStats } from '../src/core/providers/index.js';
import { buildTree, type TreeAgent } from '../src/tree.ts';

// A card in the card builder's shape (src/agent-cards.ts), every other figure n/a.
const card = (id: string, figures: Record<string, number | string>) => ({
  id,
  folder: '/work/app',
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
