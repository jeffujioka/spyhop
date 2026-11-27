// The fleet the live panel draws: the cards in the groups of their Orca hosts, this computer's
// group first, then the others in the order Orca lists their first agent; a group's cards go by
// Orca state, blocked, waiting, working, done, then any state Orca does not name, those of one
// state in the order Orca lists their agents. The number of agents in each Orca state. The burn
// rate card, summed over the sessions the cards link to and their sub-agents. And the attention
// list: the agents blocked or waiting, the sessions near their window's end and the prompt caches
// about to go cold.
// Pure: no Orca import, no I/O.

import type { BuiltCard, OrcaAgent } from './agent-cards.ts';
import { burnAt, countsInBurn, isReading, minutesOf, sumOf, sumsOf, titleOf } from './card-view.ts';
import { NA } from './core/providers/index.js';
import { MINUTE_MS, minuteOf, minuteSums } from './core/series.js';
import type { AttentionRow, BurnCard, CardView, FleetAnswer, HostGroup } from './protocol.ts';

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

// The burn rate chart names this many sessions, those of the highest cost over its minutes, and
// sums the others as one layer.
export const BURN_NAMED = 3;
// The minutes the burn rate chart draws, the minute of now the newest, and those the tokens per
// minute are summed over.
const CHART_MINUTES = 60;
const TOKENS_MINUTES = 10;

// The burn rate card of `cards` at `now` (epoch ms). Only the cards that link to a session count;
// of them, only those whose harness logs a cost per model call count in the burn rate and its
// chart, and the Claude Code ones are told as left out. A sum is n/a while a card it counts has a
// sub-agent transcript not read yet; `total` too while a card's cost cannot be read. The burn
// rate is of the last 10 minutes alone, so a call older than them that logged no cost
// leaves it to be read, though the chart, which draws older minutes, reads n/a.
export function burnCard(cards: BuiltCard[], now: number): BurnCard {
  const nowM = minuteOf(now);
  const linked = cards.filter((card) => card.linked);
  const counted = linked.filter(countsInBurn);
  const total = sumOf(
    linked.map((card) => {
      const { cost, reading } = sumsOf(card);
      return reading ? NA : cost;
    }),
  );
  const each = linked.map(minutesOf);
  const all = each.includes(NA) ? NA : (each as Exclude<(typeof each)[number], 'n/a'>[]).flat();
  const tokens = all === NA ? NA : minuteSums(all, nowM - TOKENS_MINUTES + 1, nowM).tokens / TOKENS_MINUTES;
  const hour = all === NA ? null : minuteSums(all, nowM - CHART_MINUTES + 1, nowM);
  const prompt = hour ? hour.read + hour.write + hour.uncached : 0;
  const reading = linked.some(isReading);
  return {
    perHour: sumOf(
      counted.map((card) => {
        const minutes = minutesOf(card);
        return minutes === NA ? NA : burnAt(minutes, nowM);
      }),
    ),
    total,
    tokensPerMin: tokens,
    cacheHitRate: hour && prompt > 0 ? hour.read / prompt : NA,
    running: reading ? NA : linked.flatMap((card) => card.subAgents?.agents ?? []).filter((sub) => sub.running === true).length,
    leftOut: linked.filter((card) => card.harness === 'claude').length,
    layers: burnLayers(counted, nowM),
    endMs: nowM * MINUTE_MS,
  };
}

// The layers of the burn rate chart of the cards `counted` up to the epoch minute `nowM`: the
// rate of each at each of the CHART_MINUTES minutes, oldest first, of the BURN_NAMED cards of the
// highest cost over them by title, in that order, then the others summed as `others`; n/a once a
// card's rate cannot be read at one of them.
function burnLayers(counted: BuiltCard[], nowM: number): BurnCard['layers'] {
  const rows: { card: BuiltCard; values: number[]; cost: number }[] = [];
  for (const card of counted) {
    const minutes = minutesOf(card);
    if (minutes === NA) return NA;
    const values = Array.from({ length: CHART_MINUTES }, (_, i) => burnAt(minutes, nowM - CHART_MINUTES + 1 + i));
    if (values.includes(NA)) return NA;
    // every minute of the chart is in some value's window, so no cost of them is null here
    rows.push({ card, values: values as number[], cost: minuteSums(minutes, nowM - CHART_MINUTES + 1, nowM).cost! });
  }
  rows.sort((a, b) => b.cost - a.cost);
  const named = rows.slice(0, BURN_NAMED).map(({ card, values }) => ({ name: titleOf(card), values }));
  const others = rows.slice(BURN_NAMED);
  if (others.length === 0) return named;
  return [...named, { name: 'others', values: Array.from({ length: CHART_MINUTES }, (_, i) => others.reduce((sum, { values }) => sum + values[i], 0)) }];
}

// From this percent of the window, as the panel writes it (rounded, as its level is taken), a
// session's context gets a row in the attention list and its card a chip of the tokens left before
// the harness compacts on its own (src/live/fleet.ts): one threshold, so a row and a chip never
// disagree.
export const ATTENTION_CONTEXT = 75;
// An agent that is not working gets a cache row while its session's prompt cache goes cold within
// this many ms.
export const CACHE_ROW_MS = 120_000;

// Whether a context of `share` of the window is at ATTENTION_CONTEXT or over, as written: the one
// test of both the attention list's context rows and the card's chip.
export const atAttention = (share: number) => Math.round(share * 100) >= ATTENTION_CONTEXT;

// Since when the context of `card`, of the window `window`, has been at ATTENTION_CONTEXT or over:
// the time of the first of the trailing points of its series whose context is (a point that logged
// no context is passed over); `now` when the series shows none, as when the file was not read whole.
function atAttentionSince({ stats: { detail } }: BuiltCard, window: number, now: number): number {
  const points = detail && 'points' in detail ? detail.points : [];
  let since = now;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const { t, context } = points[i];
    if (context === null) continue;
    if (!atAttention(context / window)) break;
    since = t;
  }
  return since;
}

// The attention list of `agents` and their `cards` at `now` (epoch ms): a row per agent blocked or
// waiting, the longest in its state first; then a row per linked session with a window whose
// context is at ATTENTION_CONTEXT or over, the one longest there first; then a row per agent not
// working whose session's prompt cache is warm and goes cold within CACHE_ROW_MS, the soonest
// first, which is never a session whose cache countdown cannot be read (opencode's). A row names
// its card, the one its agent shares with any others on its session (`BuiltCard.agents`).
export function attentionRows(agents: FleetAgent[], cards: BuiltCard[], now: number): AttentionRow[] {
  const cardOf = new Map(cards.flatMap((card) => card.agents.map((id) => [id, card] as const)));
  const states: AttentionRow[] = [];
  const caches: AttentionRow[] = [];
  for (const agent of agents) {
    const card = cardOf.get(agent.id);
    if (!card) continue;
    const { state, stateSince } = agent;
    if (state === 'blocked' || state === 'waiting') {
      // a time in the state that Orca does not give is written n/a
      states.push({ kind: 'state', card: card.id, title: titleOf(card), state, ...(typeof stateSince === 'number' ? { sinceMs: now - stateSince } : {}) });
    }
    const left = card.stats.cacheLeftMs;
    if (state !== 'working' && left !== NA && left > 0 && left <= CACHE_ROW_MS) {
      caches.push({ kind: 'cache', card: card.id, title: titleOf(card), coldInMs: left, rewriteTokens: card.stats.contextTokens });
    }
  }
  // an agent whose time in its state is not known goes after those whose time is
  states.sort((a, b) => (b.sinceMs ?? -1) - (a.sinceMs ?? -1));
  caches.sort((a, b) => a.coldInMs! - b.coldInMs!);
  const contexts = cards
    .flatMap((card) => {
      const { contextMax: window, contextPercent: percent, headroomTokens } = card.stats;
      if (!card.linked || window === NA || percent === NA || !atAttention(percent)) return [];
      const row: AttentionRow = { kind: 'context', card: card.id, title: titleOf(card), percent, tokensLeft: headroomTokens };
      return [{ since: atAttentionSince(card, window, now), row }];
    })
    .sort((a, b) => a.since - b.since)
    .map(({ row }) => row);
  return [...states, ...contexts, ...caches];
}
