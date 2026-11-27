// A built card's session (src/agent-cards.ts) as the live panel's session screen draws it: the
// figures row, the series of its charts, its tools and models, and its Session section, from the
// stats and the series its provider kept over the whole session file. A figure that cannot be
// read is n/a; a card that links to no session, or whose file was not read whole, has no chart.
// Sub-agents are not read yet: their share of the cost is 0, and they have no section.
// Pure: no Orca import, no I/O.

import type { BuiltCard } from './agent-cards.ts';
import { formatHomePath, formatRemote } from './core/format.js';
import { NA } from './core/providers/index.js';
import type { CardView, Num, SessionView } from './protocol.ts';

const HOUR_MS = 3_600_000;

// `home`: this computer's home folder; `host`: the name of the card's Orca host, null for this
// computer; `view`: the card as the fleet draws it; `now`: epoch ms.
export function sessionDetail(card: BuiltCard, { home, host, view }: { home: string; host: string | null; view: CardView; now: number }): SessionView {
  const { stats } = card;
  const series = card.linked && stats.detail && 'points' in stats.detail ? stats.detail : null;
  const { costUsd: cost, totalTokens: tokens, durationMs } = stats;
  const by = card.harness === 'claude' ? 'tokens' : 'cost';
  // the contexts the session reached: after a model call, and before a compaction
  const reached = series
    ? [...series.points.flatMap((point) => (point.context === null ? [] : [point.context])), ...series.marks.flatMap((mark) => (mark.before === null ? [] : [mark.before]))]
    : [];
  return {
    card: view,
    linked: card.linked,
    path: formatHomePath(card.folder, home),
    figures: {
      cost,
      subShare: cost === NA ? NA : 0,
      tokens,
      cacheShare: series && tokens !== NA && tokens > 0 ? series.points.reduce((sum, point) => sum + point.read, 0) / tokens : NA,
      calls: stats.calls,
      failedTools: series ? Object.values(series.tools).reduce((sum, tool) => sum + tool.failed, 0) : NA,
      durationMs,
      startMs: stats.firstMessageMs,
    },
    context: series && {
      window: stats.contextMax,
      latest: stats.contextTokens,
      peak: reached.length > 0 ? Math.max(...reached) : NA,
      tokensLeft: stats.headroomTokens,
      compactions: series.marks.length,
      points: series.points.flatMap(({ t, context }) => (context === null ? [] : [{ t, v: context }])),
      marks: series.marks.map(({ t, before, after }) => ({ t, before: before ?? NA, after: after ?? NA })),
    },
    tokens: series && {
      points: series.points,
      hitRate: stats.cacheHitRate,
      cold: series.cold.count > 0 ? { ...series.cold, cost: series.cold.cost ?? NA } : null,
    },
    cost: series && {
      harness: card.harnessName,
      total: cost,
      perHour: cost !== NA && durationMs !== NA && durationMs > 0 ? cost / (durationMs / HOUR_MS) : NA,
      own: ownCost(series.points),
      sub: [],
    },
    subAgents: null,
    tools: series && toolsOf(series.tools),
    models: {
      by,
      rows: Object.entries(series?.models ?? {})
        .map(([model, { cost: usd, tokens: used }]) => ({ model, main: true, subAgents: 0, value: (by === 'tokens' ? used : usd ?? NA) as Num }))
        // the largest first, those that cannot be read last
        .sort((a, b) => (b.value === NA ? -1 : b.value) - (a.value === NA ? -1 : a.value)),
    },
    session: {
      startedMs: stats.firstMessageMs,
      thinking: stats.thinkingLevel,
      latencyMs: stats.latencyMs,
      premium: stats.premiumRequests,
      branch: card.branch,
      remote: formatRemote(card.origin),
      host,
    },
  };
}

// The session's own cost after each point of its series, or n/a when a point's cost was not
// logged: a partial sum is never shown as the whole.
function ownCost(points: { t: number; cost: number | null }[]): { t: number; v: number }[] | 'n/a' {
  if (points.some((point) => point.cost === null)) return NA;
  let sum = 0;
  return points.map(({ t, cost }) => ({ t, v: (sum += cost!) }));
}

// The session's tool calls, by tool, the most called first and those of as many calls by name;
// null when it made none.
function toolsOf(tools: Record<string, { calls: number; failed: number }>): SessionView['tools'] {
  const byTool = Object.entries(tools)
    .map(([name, { calls, failed }]) => ({ name, calls, failed }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  const calls = byTool.reduce((sum, tool) => sum + tool.calls, 0);
  return calls === 0 ? null : { calls, failed: byTool.reduce((sum, tool) => sum + tool.failed, 0), byTool };
}
