// A built card's session (src/agent-cards.ts) as the live panel's session screen draws it: the
// figures row, the series of its charts, its sub-agents, its tools and models, and its Session
// section, from the stats and the series its provider kept over the whole session file and over
// each sub-agent transcript. A figure that cannot be read is n/a; a card that links to no session,
// or whose file was not read whole, has no chart. The cost and tokens hold the sub-agents' once
// every sub-agent transcript is read (`sumsOf`), and so do the cost chart's sub-agents layer, the
// cache share and the models; the model calls and the tools are the session's own.
// Pure: no Orca import, no I/O.

import type { BuiltCard, CardStats, SessionSeries } from './agent-cards.ts';
import { spentOf, sumOf, sumsOf } from './card-view.ts';
import { formatHomePath, formatRemote } from './core/format.js';
import { NA } from './core/providers/index.js';
import { groupPoints, SERIES_POINTS } from './core/series.js';
import type { CardView, Num, Point, SessionView, SubAgentView } from './protocol.ts';

const HOUR_MS = 3_600_000;

// The series a provider kept of a transcript read whole, null without one.
const seriesOf = ({ detail }: CardStats) => (detail && 'points' in detail ? detail : null);

// `home`: this computer's home folder; `host`: the name of the card's Orca host, null for this
// computer; `view`: the card as the fleet draws it; `now`: epoch ms.
export function sessionDetail(card: BuiltCard, { home, host, view }: { home: string; host: string | null; view: CardView; now: number }): SessionView {
  const { stats } = card;
  const series = card.linked ? seriesOf(stats) : null;
  const { durationMs } = stats;
  const { cost, tokens, reading, counted } = sumsOf(card);
  // Claude Code logs no cost per model call, so nothing of its cost is split
  const claude = card.harness === 'claude';
  const subCost = claude || reading ? NA : sumOf(counted.map((sub) => spentOf(sub, 'costUsd')));
  const subSeries = counted.map((sub) => seriesOf(sub.stats));
  // the contexts the session reached: after a model call, and before a compaction
  const reached = series
    ? [...series.points.flatMap((point) => (point.context === null ? [] : [point.context])), ...series.marks.flatMap((mark) => (mark.before === null ? [] : [mark.before]))]
    : [];
  // the cost the session's own model calls and side calls logged, after each of them
  const own = series ? cumulativeCost(spendsOf([series])) : NA;
  // the cache share: what the model calls read from the cache, of their tokens; side calls are out
  // of the cache figures
  const callPoints = [series, ...subSeries].map((kept) => kept?.points ?? null);
  const cacheRead = sumOf(callPoints.map((points) => (points ? points.reduce((sum, point) => sum + point.read, 0) : NA)));
  const callTokens = sumOf(callPoints.map((points) => (points ? points.reduce((sum, point) => sum + point.read + point.write + point.uncached + point.output, 0) : NA)));
  // the Copilot part of the cost, the sub-agents' while it counts them; Claude Code prices no call
  const copilot = claude ? 0 : sumOf([series, ...subSeries].map((kept) => (kept ? (kept.copilotUsd ?? 0) : NA)));
  return {
    card: view,
    linked: card.linked,
    path: formatHomePath(card.folder, home),
    figures: {
      cost,
      subShare: cost === NA || subCost === NA ? NA : cost > 0 ? subCost / cost : 0,
      tokens,
      cacheShare: cacheRead !== NA && tokens !== NA && callTokens !== NA && callTokens > 0 ? cacheRead / callTokens : NA,
      calls: stats.calls,
      failedTools: series ? Object.values(series.tools).reduce((sum, tool) => sum + tool.failed, 0) : NA,
      durationMs,
      startMs: stats.firstMessageMs,
    },
    costFrom: cost === NA || copilot === NA ? { copilot: NA, logged: NA } : { copilot, logged: cost - copilot },
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
      own,
      noCall: noCallCost(stats.costUsd, own),
      sub: subCost === NA || subSeries.some((kept) => kept === null) ? NA : cumulativeCost(spendsOf(subSeries as SessionSeries[])),
    },
    subAgents: view.subAgents && {
      ...view.subAgents,
      cost: subCost,
      agents: card.subAgents!.agents.map((sub) => subAgentView(sub, claude)),
    },
    tools: series && toolsOf(series.tools),
    models: { by: 'cost', rows: modelRows(series, counted) },
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

// The model calls and side calls of `kept` merged by time, as one series of at most SERIES_POINTS
// points.
function spendsOf(kept: SessionSeries[]): Point[] {
  return groupPoints(kept.flatMap(({ points, sides }) => [...points, ...sides]).sort((a, b) => a.t - b.t), SERIES_POINTS);
}

// A sub-agent as the Sub-agents section draws it. Its start and end are the times of its
// transcript's first and last entry, as the card builder orders the sub-agents by; a value it
// does not record reads n/a, and so does its cost on Claude Code (`claude`), which logs none per
// sub-agent.
function subAgentView({ name, kind, model, task, running, stats, start, end }: NonNullable<BuiltCard['subAgents']>['agents'][number], claude: boolean): SubAgentView {
  return {
    name,
    kind: kind ?? NA,
    model: model ?? NA,
    task: task ?? NA,
    running,
    startMs: start,
    endMs: end,
    cost: claude ? NA : stats.costUsd,
  };
}

// The cost by model over the session's own series and those of the sub-agents `counted`, each
// with what used it: the main agent, how many sub-agents, and the session's side calls; for
// Claude Code, which logs no cost per model call, the cost its newest `cost-state` gives each
// model (`costs`), its sub-agents' included, with nothing said of what used it, and else its
// models at n/a. The largest first, those that cannot be read last; the main agent's models first
// among equals. A model a harness does not say who used is its agent's own.
function modelRows(series: SessionSeries | null, counted: { stats: CardStats }[]): SessionView['models']['rows'] {
  const rows = new Map<string, SessionView['models']['rows'][number]>();
  const add = (models: SessionSeries['models'], own: boolean) => {
    for (const [model, { cost, main: used = true, side = false }] of Object.entries(models)) {
      const value: Num = cost ?? NA;
      const main = own && used;
      const subAgents = !own && used ? 1 : 0;
      const row = rows.get(model);
      if (!row) rows.set(model, { model, main, subAgents, sideCalls: own && side, value });
      else Object.assign(row, { main: row.main || main, subAgents: row.subAgents + subAgents, sideCalls: row.sideCalls || (own && side), value: sumOf([row.value, value]) });
    }
  };
  if (series?.costs) {
    for (const [model, value] of Object.entries(series.costs)) rows.set(model, { model, main: false, subAgents: 0, sideCalls: false, value });
  } else {
    if (series) add(series.models, true);
    for (const sub of counted) add(seriesOf(sub.stats)?.models ?? {}, false);
  }
  return [...rows.values()].sort((a, b) => (b.value === NA ? -1 : b.value) - (a.value === NA ? -1 : a.value));
}

// The cost spent after each of `points`, or n/a when a point's cost was not logged: a partial sum
// is never shown as the whole.
function cumulativeCost(points: Point[]): { t: number; v: number }[] | 'n/a' {
  if (points.some((point) => point.cost === null)) return NA;
  let sum = 0;
  return points.map(({ t, cost }) => ({ t, v: (sum += cost!) }));
}

// What the harness logged of the session's own cost without a model call: its logged total
// `logged` less what its model calls logged, the end of `own`, as opencode can log a session's
// total above its messages' costs; null when that is under half a cent (none, or below the
// calls), or either is not known.
function noCallCost(logged: Num, own: { t: number; v: number }[] | 'n/a'): number | null {
  if (logged === NA || own === NA) return null;
  const rest = logged - (own.at(-1)?.v ?? 0);
  return rest < 0.005 ? null : rest;
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
