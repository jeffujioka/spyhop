// The panel <-> worker contract, declared once: the live panel (src/live/controller.ts) and
// src/worker.ts read it.

// The pane of a card's Orca agent, as the worker focuses it: on this computer or an SSH
// workspace, the terminal Orca's `agents.list` names; on a paired Orca server, the handle of
// the server's terminal (`orca terminal list`) and the server's environment name.
export type Pane = { terminalId: string } | { environment: string; terminal: string };

// A figure of the live panel: a number, or n/a when it cannot be read. Times are epoch ms,
// durations ms, costs USD and shares 0..1.
export type Num = number | 'n/a';

// A card as the live panel draws it (src/card-view.ts). `stateSinceMs`: how long the agent has
// been in its Orca state. `context.compactAt`: the share of the window where the harness
// compacts on its own; `context.spark`: the contexts after the session's last model calls,
// oldest first. `cost`: with the sub-agents' once every sub-agent transcript is read, the
// session's own until then, while `reading` says how many of them are read (null once all are);
// Claude Code's is the total it logs, which holds its sub-agents'. `subAgents`: how many there
// are and how many run (n/a when the harness does not tell), null without any. `burnPerHour`: the
// cost the session and its sub-agents logged in the last 10 minutes, per hour; n/a for a harness
// that logs no cost per model call (Claude Code) and while sub-agents are being read.
export type CardView = {
  id: string;
  state: string;
  stateSinceMs: Num;
  title: string;
  folder: string;
  branch: string | null;
  harness: string;
  model: string;
  cost: Num;
  reading: { read: number; total: number } | null;
  context: { tokens: Num; window: Num; percent: Num; compactAt: Num; spark: number[] };
  tokensLeft: Num;
  cacheHitRate: Num;
  subAgents: { running: Num; total: number } | null;
  burnPerHour: Num;
  pane: Pane | null;
};

// The cards of one Orca host (src/fleet.ts): `name` as Orca names the host, `count` its cards.
export type HostGroup = { id: string; name: string; count: number; cards: CardView[] };

// The fleet's burn rate card (src/fleet.ts), over the sessions shown and their sub-agents:
// `perHour` the cost of the last 10 minutes per hour, of the harnesses that log a cost per model
// call (omp, opencode); `total` the whole cost of every linked session; `tokensPerMin` over the
// last 10 minutes and `cacheHitRate` over the last 60; `running` the sub-agents that run now;
// `leftOut` the linked sessions the rate cannot count (Claude Code's); `layers` the rate at each
// of the last 60 minutes, oldest first, USD per hour, of the BURN_NAMED sessions of the highest
// cost over them, by title, then of the others as one layer `others`; `endMs` the time of the
// newest of those minutes, the minute of now (epoch ms, its start). Each sum is n/a while a
// session it counts has a sub-agent transcript not read yet.
export type BurnCard = {
  perHour: Num;
  total: Num;
  tokensPerMin: Num;
  cacheHitRate: Num;
  running: Num;
  leftOut: number;
  layers: { name: string; values: number[] }[] | 'n/a';
  endMs: number;
};

// A row of the fleet's attention list (src/fleet.ts), which opens the screen of the card `card`,
// titled `title`. `state`: an Orca agent blocked or waiting, `sinceMs` how long it has been so
// (absent when Orca gives no time). `context`: a session at ATTENTION_CONTEXT percent of its window
// or over, `percent` its share of the window, `tokensLeft` before the harness compacts on its own.
// `cache`: an agent not working whose session's prompt cache goes cold in `coldInMs`, when the next
// model call writes `rewriteTokens` of context to it again.
export type AttentionRow = {
  kind: 'state' | 'context' | 'cache';
  card: string;
  title: string;
  state?: 'blocked' | 'waiting';
  sinceMs?: number;
  percent?: number;
  tokensLeft?: Num;
  coldInMs?: number;
  rewriteTokens?: Num;
};

// The fleet, its groups this computer's first, the number of agents in each Orca state that any
// agent is in, the burn rate card and the attention list; `request`: the panel's number of the
// request.
export type FleetAnswer = {
  request: number;
  groups: HostGroup[];
  counts: Partial<Record<'blocked' | 'waiting' | 'working' | 'done', number>>;
  burn: BurnCard;
  attention: AttentionRow[];
};

// One Orca host's group, posted during a fleet request as soon as that host's cards are built.
export type GroupPost = { request: number; group: HostGroup };

// One point of a session's series of model calls (src/core/series.js): `n` neighbouring calls as
// one, dated by the last of them, with the prompt tokens they read from the cache, wrote to it
// and sent uncached, their output tokens, their cost (null: one of them logged none) and the
// context after the last that logged one (null: none did).
export type Point = { t: number; n: number; read: number; write: number; uncached: number; output: number; cost: number | null; context: number | null };

// A sub-agent of a session as the Sub-agents section draws it: its name, agent kind, model and
// task (n/a: not told), whether it runs (null: the harness does not tell), the times of its
// transcript's first and last entry and its cost (n/a on Claude Code, which logs none per
// sub-agent).
export type SubAgentView = { name: string; kind: string; model: string; task: string; running: boolean | null; startMs: Num; endMs: Num; cost: Num };

// The Trace of a session the history store keeps (src/history/store.ts): its axis, from its start
// to its end (epoch ms); its lanes, each with its spans (`[start, end]`, epoch ms, oldest first)
// and its total time, `subagents` the main agent's wait on its sub-agents; and its sub-agents,
// each under the agent that started it (`depth` 0 for one the main agent started), with its
// status as the harness logs it (`running` while it runs, n/a when not logged), its cost and its
// times (n/a when not known).
export type TraceView = {
  startMs: number;
  endMs: number;
  lanes: { lane: 'thinking' | 'tools' | 'subagents' | 'developer'; totalMs: number; spans: [number, number][] }[];
  agents: { name: string; status: string; cost: Num; startMs: Num; endMs: Num; depth: number }[];
};

// A session summary the history store keeps: its id (`<host>\0<harness>\0<main file or opencode
// root id>`), title, repo, harness, Orca host (its key in the store), models, its cost and tokens
// with its sub-agents', how long it ran and how many sub-agents it has.
export type SessionSummary = { id: string; title: string; repo: string; harness: string; host: string; models: string[]; cost: Num; tokens: Num; durationMs: Num; subAgents: number };

// One card's session as the session screen draws it (src/session-detail.ts). `linked`: whether
// the card links to a session; `path`: its folder for reading. `figures`: the figures row, its
// cost and tokens as the card's cost is summed, `subShare` the sub-agents' share of the cost (n/a
// on Claude Code, and while they are being read); `context`, `tokens`, `cost` and `tools`: the
// series and tallies of the whole session file, null when it was not read whole or the card links
// to none (`tools` too when the session made no tool call), `cost.sub` the sub-agents' cost over
// time, `cost.noCall` what the harness logged of the session's own cost without a model call
// (null when nothing); `subAgents`: the session's sub-agents, in the order they started, null
// without any; `costFrom`: where the figures' cost comes from, the cost of the Copilot calls
// priced from the Copilot price table and the rest as the harness logged it, the sub-agents'
// included as the cost counts them (both n/a when the cost or the split is not known);
// `models`: the cost of the session and its sub-agents by model, each with what used it where the
// harness says (Claude Code does not): the main agent, how many sub-agents, and the session's side
// calls;
// `session`: the Session section, `host` the Orca host's name when it is not this computer;
// `trace`: the session's Trace when the request asks for it, null when it cannot be read, absent
// when not asked for.
export type SessionView = {
  card: CardView;
  linked: boolean;
  path: string;
  figures: { cost: Num; subShare: Num; tokens: Num; cacheShare: Num; calls: Num; failedTools: Num; durationMs: Num; startMs: Num };
  costFrom: { copilot: Num; logged: Num };
  context: {
    window: Num;
    latest: Num;
    peak: Num;
    tokensLeft: Num;
    compactions: number;
    points: { t: number; v: number }[];
    marks: { t: number; before: Num; after: Num }[];
  } | null;
  tokens: { points: Point[]; hitRate: Num; cold: { count: number; tokens: number; cost: Num } | null } | null;
  cost: { harness: string; total: Num; perHour: Num; own: { t: number; v: number }[] | 'n/a'; noCall: number | null; sub: { t: number; v: number }[] | 'n/a' } | null;
  subAgents: { running: Num; total: number; cost: Num; agents: SubAgentView[] } | null;
  tools: { calls: number; failed: number; byTool: { name: string; calls: number; failed: number }[] } | null;
  models: { by: 'cost'; rows: { model: string; main: boolean; subAgents: number; sideCalls: boolean; value: Num }[] };
  session: { startedMs: Num; thinking: string; latencyMs: Num; premium: Num; branch: string | null; remote: string | null; host: string | null };
  trace?: TraceView | null;
};

// The session of the card a session request asks for, or null when Orca no longer lists its
// agent.
export type SessionAnswer = { request: number; session: SessionView | null };

// A range of the range tabs (src/core/days.js): Day is today, Week the 7 and Month the 30 days that
// end today, Year the 12 calendar months that end with this month, in this computer's time zone.
export type Range = 'day' | 'week' | 'month' | 'year';
export type RangeTab = 'spend' | 'cache' | 'health';

// A point of a range chart: its day (`YYYY-MM-DD`, Week and Month) or month (`YYYY-MM`, Year) and
// its value there.
export type RangePoint = { key: string; v: Num };

// A row of a Spend tab's list: what it is of (a repo, a model, a harness) and its cost.
export type SpendRow = { name: string; cost: Num };

// A row of the Spend tab's costliest sessions: the session's id (`<host>\0<harness>\0<main file or
// opencode root id>`), title, repo, harness, the Orca host's name and whole cost, with its
// sub-agents'; `card`: the id of the Live card of the session, null for a past session, which has
// none.
export type CostlySession = { id: string; title: string; repo: string; harness: string; host: string; cost: Num; card: string | null };

// The Spend tab of a range (src/history/views.ts), over every session the history store holds,
// sub-agents included: its cost (n/a when a model call of it logged none), tokens and model calls,
// and its cost by day or month, null for Day; its cost by repo, by model (with its provider where
// the harness logs one) and by harness, each costliest first, a cost n/a last; `costliest`: the
// COSTLIEST costliest sessions that logged a model call in the range, costliest first, a cost n/a
// last; the cost of omp's
// side calls; and where the cost comes from, the Copilot calls' cost from the Copilot price table
// and the rest as the harnesses logged it (both n/a when the cost is). Every figure n/a, the lists
// empty, no chart and no sources when the store cannot be opened.
export type SpendView = {
  cost: Num;
  tokens: Num;
  calls: Num;
  chart: RangePoint[] | null;
  byRepo: SpendRow[];
  byModel: SpendRow[];
  byHarness: SpendRow[];
  costliest: CostlySession[];
  sideCost: Num;
  sources: { copilot: Num; logged: Num } | null;
};

// The Cache tab of a range (src/history/views.ts): its cache hit rate, read over what the model
// calls read from the prompt cache, wrote to it and sent not cached (n/a without a call), as a share
// of 1, and by day or month, null for Day; for each miss cause (`expired`, `model`, `thinking`,
// `compaction`, `other`) its cold starts, the tokens they wrote to the cache again and their cost,
// null when no cold start of it has one (its harness logs none); `costLeftOut`: the harnesses
// whose cold starts the cost leaves out; for each time away (`under5`, `to60`, `over60`) its
// returns and how many found the cache cold; and the compactions by kind, `inferred` of them told
// apart by inference. Every figure n/a, no chart, when the store cannot be opened or read.
export type CacheView = {
  hitRate: Num;
  chart: RangePoint[] | null;
  causes: { cause: string; cold: Num; tokens: Num; cost: Num | null }[];
  costLeftOut: string[];
  away: { band: string; returns: Num; cold: Num }[];
  compactions: { idle: Num; full: Num; manual: Num; inferred: Num };
};

// The Health tab of a range (src/history/views.ts): `failed`, its failed model calls, and them by
// type (`network`, `auth`, `notFound`, `rateLimit`, `server`, `other`), by Orca host (named as the
// Spend tab names it) and by provider (the model's part before the `/`, else `n/a`), each list the
// rows there are, most calls first, equal counts by type order (types) or by name (hosts, providers); `retries`: the model calls that failed and then succeeded on a
// retry, `retriesLeftOut`: the harnesses that log none; per model, by model name, the `typical` (median)
// and `slow` (95th percentile) reply time in ms of the calls that ended without failure, the calls
// `cut` at the maximum length with their cost (n/a when one of them logged none), most calls first, equal counts by model name, and the thinking
// `tokens` (n/a for a model that logged none); `cutLeftOut` and `thinkingLeftOut`: the harnesses
// whose figure leaves them out. Every figure n/a, no row, when the store cannot be opened or read.
export type HealthView = {
  failed: Num;
  byType: { name: string; count: number }[];
  byHost: { name: string; count: number }[];
  byProvider: { name: string; count: number }[];
  retries: Num;
  retriesLeftOut: string[];
  replies: { model: string; typical: Num; slow: Num }[];
  cut: { model: string; calls: number; cost: Num }[];
  cutLeftOut: string[];
  thinking: { model: string; tokens: Num }[];
  thinkingLeftOut: string[];
};

// What the running catch-up is reading (src/history/catch-up.ts): the Orca host's name, the
// harness's and the share of its bytes read, from 0 to 1.
export type ReadProgress = { host: string; harness: string; share: number };

// The range tab `tab` over `range`, as the history store holds it: the Spend tab's view when it is
// the Spend tab, the Cache tab's when it is the Cache tab, the Health tab's when it is the Health tab, else null; `notRead`: the names of the Orca hosts the last catch-up could not
// read, whose figures are those read before; `progress`: what the running catch-up is reading of
// a host and harness never read through, else null; `request`: the panel's number of the request.
export type RangeAnswer = { request: number; tab: RangeTab; range: Range; spend: SpendView | null; cache: CacheView | null; health: HealthView | null; notRead: string[]; progress: ReadProgress | null };

// A past session, one with no Live card: what the history store keeps of it, its summary and its
// Trace (null when it has none), or null when the store keeps none. `request`: the panel's number
// of the request.
export type PastAnswer = { request: number; past: { summary: SessionSummary; trace: TraceView | null } | null };

declare module 'orca' {
  interface PluginRequests {
    /** The fleet of the Orca agents' cards on every Orca host, built once per request.
     *  `request`: the panel's number of the request, which the groups posted during it carry
     *  (`spyhop.group`). */
    'spyhop.fleet': { input: { request: number }; output: FleetAnswer };
    /** The session of one card, built as the fleet is, which posts nothing. `request`: the
     *  panel's number of the request; `card`: the card's id; `trace`: whether to answer the
     *  session's Trace too, its session file brought up to date in the history store first. */
    'spyhop.session': { input: { request: number; card: string; trace?: boolean }; output: SessionAnswer };
    /** The range tab `tab` over `range`, from the history store as it is now. `request`: the
     *  panel's number of the request. */
    'spyhop.range': { input: { request: number; tab: RangeTab; range: Range }; output: RangeAnswer };
    /** The summary and Trace of the session `session` (its id), from the history store as it is
     *  now, whatever the harness has deleted since. `request`: the panel's number of the request. */
    'spyhop.past': { input: { request: number; session: string }; output: PastAnswer };
    /** Focuses the pane in this computer's Orca window; `focused` false when it could not, the
     *  reason in the worker's log. */
    'spyhop.focus': { input: Pane; output: { focused: boolean } };
  }
  interface PluginPanelEvents {
    'spyhop.group': GroupPost;
  }
}
