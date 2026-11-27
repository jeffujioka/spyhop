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
// oldest first. `reading`, `subAgents` and `burnPerHour` are not read yet: null, null and n/a.
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

declare module 'orca' {
  interface PluginRequests {
    /** The fleet of the Orca agents' cards on every Orca host, built once per request.
     *  `request`: the panel's number of the request, which the groups posted during it carry
     *  (`spyhop.group`). */
    'spyhop.fleet': { input: { request: number }; output: FleetAnswer };
    /** Focuses the pane in this computer's Orca window; `focused` false when it could not, the
     *  reason in the worker's log. */
    'spyhop.focus': { input: Pane; output: { focused: boolean } };
  }
  interface PluginPanelEvents {
    'spyhop.group': GroupPost;
  }
}
