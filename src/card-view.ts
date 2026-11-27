// A built card (src/agent-cards.ts) as the live panel draws it: the figures of its session as
// numbers, n/a where they cannot be read, its cost with its sub-agents' once every sub-agent
// transcript is read, and the texts of its agent and folder.
// Pure: no Orca import, no I/O.

import type { BuiltCard } from './agent-cards.ts';
import { formatFolderName, formatSessionTitle } from './core/format.js';
import { NA } from './core/providers/index.js';
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

// A session's cost and tokens with its sub-agents', sub-agents of sub-agents included (the
// provider's hook lists them all). They are summed only once every sub-agent transcript is
// read; until then they are the session's own, and `reading` says how many are read. Claude
// Code's cost is the total it logs, which holds its sub-agents' already, so nothing is added to
// it. `counted`: the sub-agents in the sums, none while some are being read.
export function sumsOf({ harness, stats, subAgents }: BuiltCard): { cost: Num; tokens: Num; reading: CardView['reading']; counted: SubAgent[] } {
  const allRead = subAgents === null || subAgents.read === subAgents.total;
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
  const folder = formatFolderName(card.folder);
  const { cost, reading } = sumsOf(card);
  return {
    id: card.id,
    state: card.status,
    stateSinceMs: card.stateSince === null ? NA : now - card.stateSince,
    title: formatSessionTitle(card.title, card.folder, card.harness)?.value ?? folder,
    folder,
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
    burnPerHour: NA,
    pane,
  };
}
