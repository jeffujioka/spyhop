// A built card (src/agent-cards.ts) as the live panel draws it: the figures of its session as
// numbers, n/a where they cannot be read, and the texts of its agent and folder.
// Pure: no Orca import, no I/O.

import type { BuiltCard } from './agent-cards.ts';
import { formatFolderName, formatSessionTitle } from './core/format.js';
import { NA } from './core/providers/index.js';
import type { CardView, Num, Pane } from './protocol.ts';

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
  return {
    id: card.id,
    state: card.status,
    stateSinceMs: card.stateSince === null ? NA : now - card.stateSince,
    title: formatSessionTitle(card.title, card.folder, card.harness)?.value ?? folder,
    folder,
    branch: card.branch,
    harness: card.harnessName,
    model: stats.model,
    cost: stats.costUsd,
    reading: null,
    context: {
      tokens: stats.contextTokens,
      window: stats.contextMax,
      percent: stats.contextPercent,
      compactAt: compactAtOf(stats),
      spark: stats.detail?.recent ?? [],
    },
    tokensLeft: stats.headroomTokens,
    cacheHitRate: stats.cacheHitRate,
    subAgents: null,
    burnPerHour: NA,
    pane,
  };
}
