// A built card (src/agent-cards.ts) as the live panel draws it: the figures of its session as
// numbers, n/a where they cannot be read, its cost with its sub-agents' once every sub-agent
// transcript is read, its burn rate, and the texts of its agent and folder. And what the fleet's
// burn rate card (src/fleet.ts) sums of each card: its per-minute sums and its burn rate.
// Pure: no Orca import, no I/O.

import type { BuiltCard, Minute } from './agent-cards.ts';
import { formatFolderName, formatSessionTitle } from './core/format.js';
import { NA } from './core/providers/index.js';
import { minuteOf, minuteSums } from './core/series.js';
import type { CardView, Num, Pane } from './protocol.ts';

type SubAgent = NonNullable<BuiltCard['subAgents']>['agents'][number];

// The sum of `figures`, n/a once one of them is: a partial sum is never shown as the whole.
export function sumOf(figures: Num[]): Num {
  let sum = 0;
  for (const figure of figures) {
    if (figure === NA) return NA;
    sum += figure;
  }
  return sum;
}

// What the sub-agent `sub` spent of `figure`: nothing when it logged none before its first model
// call, as omp logs no cost and no tokens until then and a sub-agent that is starting, or was
// stopped before it answered, spent nothing; n/a when it made calls but logged none.
export function spentOf(sub: SubAgent, figure: 'costUsd' | 'totalTokens'): Num {
  const spent = sub.stats[figure];
  return spent === NA && sub.stats.calls === 0 ? 0 : spent;
}

// Whether some of the sub-agent transcripts of the session of `card` are not read yet: until
// they are, a sum with its sub-agents is the session's own, or n/a. The one rule of it.
export const isReading = ({ subAgents }: BuiltCard) => Boolean(subAgents) && subAgents!.read < subAgents!.total;

// A session's cost and tokens with its sub-agents', sub-agents of sub-agents included (the
// provider's hook lists them all). They are summed only once every sub-agent transcript is
// read; until then they are the session's own, and `reading` says how many are read. Claude
// Code's cost is the total it logs, which holds its sub-agents' already, so nothing is added to
// it. `counted`: the sub-agents in the sums, none while some are being read.
export function sumsOf(card: BuiltCard): { cost: Num; tokens: Num; reading: CardView['reading']; counted: SubAgent[] } {
  const { harness, stats, subAgents } = card;
  const allRead = !isReading(card);
  const counted = allRead && subAgents ? subAgents.agents : [];
  return {
    cost: harness === 'claude' ? stats.costUsd : sumOf([stats.costUsd, ...counted.map((sub) => spentOf(sub, 'costUsd'))]),
    tokens: sumOf([stats.totalTokens, ...counted.map((sub) => spentOf(sub, 'totalTokens'))]),
    reading: allRead ? null : { read: subAgents!.read, total: subAgents!.total },
    counted,
  };
}

// The session's sub-agents for the card: how many there are, and how many run, n/a when the
// harness does not tell (Claude Code, opencode); null when it has none, or tells none.
function subAgentsOf({ subAgents }: BuiltCard): CardView['subAgents'] {
  if (!subAgents || subAgents.total === 0) return null;
  const { agents, total } = subAgents;
  return { running: agents.some((sub) => sub.running === null) ? NA : agents.filter((sub) => sub.running).length, total };
}

// The Orca agent kinds whose harness logs a cost per model call (omp, opencode), so whose
// sessions have a burn rate; Claude Code logs one total per session.
const COSTS_PER_CALL: Record<string, true> = { omp: true, opencode: true, opencode2: true };

// Whether `card` counts in the burn rate: it links to a session of a harness that logs a cost per
// model call.
export const countsInBurn = ({ linked, harness }: BuiltCard) => linked && Object.hasOwn(COSTS_PER_CALL, harness ?? '');

// A burn rate sums the cost of this many minutes, the minute it is of included.
const BURN_MINUTES = 10;

// The per-minute sums of the session of `card` and of its sub-agents, one list in no order (each
// minute is summed where it falls); n/a while a sub-agent transcript is not read yet, or when a
// file was not read whole. A sub-agent with no model call yet adds nothing.
export function minutesOf(card: BuiltCard): Minute[] | 'n/a' {
  if (isReading(card)) return NA;
  const { stats, subAgents } = card;
  const files = [stats, ...(subAgents?.agents ?? []).map((sub) => sub.stats).filter((sub) => sub.calls !== 0)];
  const lists = files.map(({ detail }) => (detail && 'minutes' in detail ? detail.minutes : null));
  return lists.includes(null) ? NA : (lists as Minute[][]).flat();
}

// The burn rate of `minutes` at the epoch minute `m`: the cost of the BURN_MINUTES minutes up to
// it, per hour; n/a when one of their model calls logged no cost.
export function burnAt(minutes: Minute[], m: number): Num {
  const { cost } = minuteSums(minutes, m - BURN_MINUTES + 1, m);
  return cost === null ? NA : (cost * 60) / BURN_MINUTES;
}

// The title a card shows: its session's, or its folder's name for an untitled one.
export const titleOf = (card: BuiltCard) => formatSessionTitle(card.title, card.folder, card.harness)?.value ?? formatFolderName(card.folder);

// The burn rate of `card` at `now` (epoch ms), n/a when it does not count in the burn rate.
function burnPerHourOf(card: BuiltCard, now: number): Num {
  const minutes = countsInBurn(card) ? minutesOf(card) : NA;
  return minutes === NA ? NA : burnAt(minutes, minuteOf(now));
}

// Where the harness compacts on its own, as a share of the window: the context plus the
// headroom left before the trigger. A trigger past the window marks the window's end; with
// the headroom used up, the trigger is at the context.
function compactAtOf({ contextTokens, contextMax, headroomTokens }: BuiltCard['stats']): Num {
  if (contextTokens === NA || contextMax === NA || headroomTokens === NA) return NA;
  return Math.min(1, Math.max(0, (contextTokens + headroomTokens) / contextMax));
}

// `home`: this computer's home folder. `pane`: the pane of the card's agent, the first of the
// agents that share it. `now`: epoch ms.
export function cardView(card: BuiltCard, { pane, now }: { home: string; pane: Pane | null; now: number }): CardView {
  const { stats } = card;
  const { cost, reading } = sumsOf(card);
  return {
    id: card.id,
    state: card.status,
    stateSinceMs: card.stateSince === null ? NA : now - card.stateSince,
    title: titleOf(card),
    folder: formatFolderName(card.folder),
    branch: card.branch,
    harness: card.harnessName,
    model: stats.model,
    cost,
    reading,
    context: {
      tokens: stats.contextTokens,
      window: stats.contextMax,
      percent: stats.contextPercent,
      compactAt: compactAtOf(stats),
      spark: stats.detail?.recent ?? [],
    },
    tokensLeft: stats.headroomTokens,
    cacheHitRate: stats.cacheHitRate,
    subAgents: subAgentsOf(card),
    burnPerHour: burnPerHourOf(card, now),
    pane,
  };
}
