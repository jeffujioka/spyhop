// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { HostRow } from './tree.ts';

// A figure of a card: its text, its tone and, for some, a label (src/core/card-model.js).
export type Figure = { value: string; tone: string; label?: string };

// What a card shows of its agent and session (the identity group of src/core/card-model.js).
export type CardIdentity = {
  id: 'identity';
  status: { tone: string; label: string };
  name: Figure;
  session: Figure | null;
  path: Figure;
  branch: string | null;
  remote: string | null;
  machine: string | null;
  harness: Figure;
  model: Figure;
};

// One group of figures of a card: context, spend, cache or activity.
export type CardGroup = { id: string; title: string; hero: Figure | null; figures: Figure[] };

// The pane of a card's Orca agent, as the worker focuses it: on this computer or an SSH
// workspace, the terminal Orca's `agents.list` names; on a paired Orca server, the handle of
// the server's terminal (`orca terminal list`) and the server's environment name.
export type Pane = { terminalId: string } | { environment: string; terminal: string };

// A card as the panel draws it: the core's view model of the card (src/core/card-model.js),
// with the pane of its agent, the first of the agents that share it; null when it has none.
export type CardView = { id: string; focused: boolean; groups: [CardIdentity, ...CardGroup[]]; pane: Pane | null };

export type TreeAnswer = {
  // The Orca hosts, with their Orca projects and workspaces that have an Orca agent (src/tree.ts).
  hosts: HostRow<CardView>[];
  // Orca's id of the focused Orca workspace, as `workspace.readContext` answers it; null when no
  // workspace is focused. The panel finds its row by the rows' `workspaceIds`.
  focused: string | null;
};

// One Orca host's row, posted during a `spyhop.tree` request as soon as that host's cards are
// built: the row as the answer will hold it, the number the panel gave the request, and the
// answer's `focused`.
export type HostRowPost = { request: number; host: HostRow<CardView>; focused: string | null };

declare module 'orca' {
  interface PluginRequests {
    /** The tree of this computer's Orca agents, built once per request. `request`: the panel's
     *  number of the request, which the host rows posted during it carry (`spyhop.host`); asked
     *  without one, the worker posts none. */
    'spyhop.tree': { input: { request: number } | undefined; output: TreeAnswer };
    /** Focuses the pane in this computer's Orca window; `focused` false when it could not, the
     *  reason in the worker's log. */
    'spyhop.focus': { input: Pane; output: { focused: boolean } };
  }
  interface PluginPanelEvents {
    'spyhop.host': HostRowPost;
  }
}
