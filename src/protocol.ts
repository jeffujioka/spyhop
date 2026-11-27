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
// are and how many run (n/a when the harness does not tell), null without any. `burnPerHour` is
// not read yet: n/a.
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

// The fleet, its groups this computer's first, and the number of agents in each Orca state that
// any agent is in; `request`: the panel's number of the request.
export type FleetAnswer = {
  request: number;
  groups: HostGroup[];
  counts: Partial<Record<'blocked' | 'waiting' | 'working' | 'done', number>>;
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

// One card's session as the session screen draws it (src/session-detail.ts). `linked`: whether
// the card links to a session; `path`: its folder for reading. `figures`: the figures row, its
// cost and tokens as the card's cost is summed, `subShare` the sub-agents' share of the cost (n/a
// on Claude Code, and while they are being read); `context`, `tokens`, `cost` and `tools`: the
// series and tallies of the whole session file, null when it was not read whole or the card links
// to none (`tools` too when the session made no tool call), `cost.sub` the sub-agents' cost over
// time; `subAgents`: the session's sub-agents, in the order they started, null without any;
// `models`: the models of the session and its sub-agents by what the harness logs of them;
// `session`: the Session section, `host` the Orca host's name when it is not this computer.
export type SessionView = {
  card: CardView;
  linked: boolean;
  path: string;
  figures: { cost: Num; subShare: Num; tokens: Num; cacheShare: Num; calls: Num; failedTools: Num; durationMs: Num; startMs: Num };
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
  cost: { harness: string; total: Num; perHour: Num; own: { t: number; v: number }[] | 'n/a'; sub: { t: number; v: number }[] | 'n/a' } | null;
  subAgents: { running: Num; total: number; cost: Num; agents: SubAgentView[] } | null;
  tools: { calls: number; failed: number; byTool: { name: string; calls: number; failed: number }[] } | null;
  models: { by: 'cost' | 'tokens'; rows: { model: string; main: boolean; subAgents: number; value: Num }[] };
  session: { startedMs: Num; thinking: string; latencyMs: Num; premium: Num; branch: string | null; remote: string | null; host: string | null };
};

// The session of the card a session request asks for, or null when Orca no longer lists its
// agent.
export type SessionAnswer = { request: number; session: SessionView | null };

declare module 'orca' {
  interface PluginRequests {
    /** The fleet of the Orca agents' cards on every Orca host, built once per request.
     *  `request`: the panel's number of the request, which the groups posted during it carry
     *  (`spyhop.group`). */
    'spyhop.fleet': { input: { request: number }; output: FleetAnswer };
    /** The session of one card, built as the fleet is, which posts nothing. `request`: the
     *  panel's number of the request; `card`: the card's id. */
    'spyhop.session': { input: { request: number; card: string }; output: SessionAnswer };
    /** Focuses the pane in this computer's Orca window; `focused` false when it could not, the
     *  reason in the worker's log. */
    'spyhop.focus': { input: Pane; output: { focused: boolean } };
  }
  interface PluginPanelEvents {
    'spyhop.group': GroupPost;
  }
}
