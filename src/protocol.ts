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

// A card as the panel draws it: the core's view model of the card (src/core/card-model.js).
export type CardView = { id: string; focused: boolean; groups: [CardIdentity, ...CardGroup[]] };

export type TreeAnswer = {
  // The Orca hosts, with their Orca projects and workspaces that have an Orca agent (src/tree.ts).
  hosts: HostRow<CardView>[];
  // The id of the focused Orca workspace's row, null when no row is focused.
  focused: string | null;
};

declare module 'orca' {
  interface PluginRequests {
    /** The tree of this computer's Orca agents, built once per request. */
    'spyhop.tree': { output: TreeAnswer };
  }
}
