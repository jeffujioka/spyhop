// The fleet the live panel draws: the cards in the groups of their Orca hosts, this computer's
// group first, then the others in the order Orca lists their first agent; a group's cards go by
// Orca state, blocked, waiting, working, done, then any state Orca does not name, those of one
// state in the order Orca lists their agents. And the number of agents in each Orca state.
// Pure: no Orca import, no I/O.

import type { OrcaAgent } from './agent-cards.ts';
import type { CardView, FleetAnswer, HostGroup } from './protocol.ts';

// An Orca agent with the Orca host it is on (`local` for this computer) and Orca's id of its
// workspace. `id` is the id its card is built with (src/agent-cards.ts), so agents that share a
// session find their one card through the first.
export type FleetAgent = OrcaAgent & { hostId: string; workspaceId: string };

// Orca's id of this computer's host; a workspace that records no host is on this computer.
export const LOCAL = 'local';

// The Orca states in the order a group's cards and the header's counts go by.
export const STATES = ['blocked', 'waiting', 'working', 'done'] as const;

// The place of each Orca state in a group's cards; any other state goes after them.
const STATE_ORDER: Record<string, number> = Object.fromEntries(STATES.map((state, at) => [state, at]));

// `cards`: the views of the cards the card builder returns for `agents`. `names`: host id ->
// its name as Orca gives it; a host without one is named by its id.
export function groupCards(agents: FleetAgent[], cards: CardView[], names: Map<string, string>): HostGroup[] {
  const cardOf = new Map(cards.map((card) => [card.id, card]));
  // host id -> its cards, in the order Orca lists the hosts' first agents, this computer first
  const hosts = new Map<string, CardView[]>(agents.some((agent) => agent.hostId === LOCAL) ? [[LOCAL, []]] : []);
  for (const agent of agents) {
    if (!hosts.has(agent.hostId)) hosts.set(agent.hostId, []);
    const card = cardOf.get(agent.id);
    if (card) hosts.get(agent.hostId)!.push(card);
  }
  return [...hosts].map(([id, hostCards]) => {
    // stable, so the cards of one state keep the order of their agents
    hostCards.sort((a, b) => (STATE_ORDER[a.state] ?? STATES.length) - (STATE_ORDER[b.state] ?? STATES.length));
    return { id, name: names.get(id) ?? id, count: hostCards.length, cards: hostCards };
  });
}

// `groups` with `group` in the place of the group of its host, or after them when none has it.
export function withGroup(groups: HostGroup[], group: HostGroup): HostGroup[] {
  const at = groups.findIndex((drawn) => drawn.id === group.id);
  return at < 0 ? [...groups, group] : groups.with(at, group);
}

// The number of `agents` in each Orca state that any of them is in.
export function stateCounts(agents: FleetAgent[]): FleetAnswer['counts'] {
  const counts: FleetAnswer['counts'] = {};
  for (const { state } of agents) {
    if (Object.hasOwn(STATE_ORDER, state)) counts[state] = (counts[state] ?? 0) + 1;
  }
  return counts;
}
