// The tree the panel draws: Orca host → Orca project → Orca workspace → cards. Only the Orca
// workspaces that have an Orca agent are listed, with the projects and hosts that hold them, in
// the order Orca lists the agents. Project and workspace rows carry the Totals of cost, tokens
// and premium requests over the cards under them; a Total reads n/a when any of those cards
// reads n/a for it, so a part is never shown as the whole. Pure: no Orca import, no I/O.

import { formatCost, formatTokens, orNa } from './core/format.js';
import { NA } from './core/providers/index.js';

// Where Orca puts an agent (`orca agent list --json`); `id` is the id its card is built with
// (src/agent-cards.ts), so agents that share a session find their one card through the first.
// `worktreeId` is `<repoId>::<worktreePath>`, the repoId being the Orca project's id.
export type TreeAgent = { id: string; hostId: string; repo: string; workspace: string; worktreeId: string };

type Figure = number | typeof NA;
type Card = { id: string; stats: { costUsd: Figure; totalTokens: Figure; premiumRequests: Figure } };

export type Totals = { cost: string; tokens: string; premium: string };
export type WorkspaceRow<C> = { id: string; name: string; totals: Totals; cards: C[] };
export type ProjectRow<C> = { id: string; name: string; totals: Totals; workspaces: WorkspaceRow<C>[] };
export type HostRow<C> = { id: string; name: string; projects: ProjectRow<C>[] };

// The sum of one figure over `cards`, n/a when any card reads n/a for it.
function total(cards: Card[], figure: keyof Card['stats']): Figure {
  let sum = 0;
  for (const card of cards) {
    const value = card.stats[figure];
    if (value === NA) return NA;
    sum += value;
  }
  return sum;
}

function totalsOf(cards: Card[]): Totals {
  return {
    cost: formatCost(total(cards, 'costUsd')),
    tokens: orNa(total(cards, 'totalTokens'), formatTokens),
    premium: orNa(total(cards, 'premiumRequests'), String),
  };
}

// `cards`: as the card builder returns them for `agents`, one card per shared harness session.
export function buildTree<C extends Card>(agents: TreeAgent[], cards: C[]): HostRow<C>[] {
  const cardOf = new Map(cards.map((card) => [card.id, card]));
  // host -> project -> workspace -> its rows' names and cards, in agent order. Row ids are
  // unique across hosts: the project's by host and Orca project id, so two projects of one name
  // on one host stay apart, the workspace's by host and worktreeId.
  type Workspace = { name: string; cards: C[] };
  const hosts = new Map<string, Map<string, { name: string; workspaces: Map<string, Workspace> }>>();
  for (const agent of agents) {
    if (!hosts.has(agent.hostId)) hosts.set(agent.hostId, new Map());
    const projects = hosts.get(agent.hostId)!;
    const projectId = `${agent.hostId}\0${agent.worktreeId.slice(0, agent.worktreeId.indexOf('::'))}`;
    if (!projects.has(projectId)) projects.set(projectId, { name: agent.repo, workspaces: new Map() });
    const { workspaces } = projects.get(projectId)!;
    const workspaceId = `${agent.hostId}\0${agent.worktreeId}`;
    if (!workspaces.has(workspaceId)) workspaces.set(workspaceId, { name: agent.workspace, cards: [] });
    const card = cardOf.get(agent.id);
    if (card) workspaces.get(workspaceId)!.cards.push(card);
  }
  return [...hosts].map(([host, projects]) => ({
    id: host,
    name: host,
    projects: [...projects].map(([id, { name, workspaces }]) => {
      const rows = [...workspaces].map(([id, { name, cards }]) => ({ id, name, totals: totalsOf(cards), cards }));
      return { id, name, totals: totalsOf(rows.flatMap((row) => row.cards)), workspaces: rows };
    }),
  }));
}
