// The plugin's own worker: answers the panel with the tree of this computer's Orca agents
// (src/protocol.ts). Each request lists the Orca workspaces and the agents in each, builds
// their cards from the harnesses' session files (src/agent-cards.ts) and groups them into the
// tree (src/tree.ts), from that one agent list.
import { homedir } from 'node:os';
import type { OrcaWorkerApi } from 'orca/worker';
import { createAgentCards, type OrcaAgent } from './agent-cards.ts';
import { cardModel } from './core/card-model.js';
import { run } from './exec.ts';
import type { CardView, TreeAnswer } from './protocol.ts';
import { buildTree, type TreeAgent, workspaceRowId } from './tree.ts';

// Orca's id of this computer's host; a workspace that records no host is on this computer.
const LOCAL = 'local';

export default function activate(orca: OrcaWorkerApi): void {
  const home = homedir();
  // kept for the worker's life: it keeps the state of its session reads between builds
  const cards = createAgentCards({ run, home });

  orca.panels.handle('spyhop.tree', async (): Promise<TreeAnswer> => {
    const [{ workspaces }, context] = await Promise.all([
      orca.host.call('workspace.list'),
      orca.host.call('workspace.readContext'),
    ]);
    const local = workspaces.filter((workspace) => (workspace.hostId ?? LOCAL) === LOCAL);
    // `agents.list` lists one workspace's agents. Its `sessionId` is the harness's own session
    // id (what `agent.resume` takes), so a card links by it (src/core/session-link.js). A
    // workspace whose agents cannot be listed (removed since `workspace.list`) shows none, and
    // the others are drawn.
    const lists = await Promise.all(
      local.map((workspace) =>
        orca.host.call('agents.list', { workspaceId: workspace.id }).catch(() => ({ agents: [] })),
      ),
    );
    let focused: string | null = null;
    const agents: (OrcaAgent & TreeAgent)[] = local.flatMap((workspace, i) => {
      // `<repoId>::<path>`, as Orca names a worktree, the repoId being the Orca project's id
      const worktreeId = `${workspace.projectId ?? workspace.id}::${workspace.path}`;
      if (workspace.id === context?.workspaceId) focused = workspaceRowId(LOCAL, worktreeId);
      return lists[i].agents.map((agent, n) => ({
        id: `${workspace.id}\0${agent.terminalId ?? n}`,
        agent: agent.agent,
        state: agent.state,
        title: agent.title,
        sessionId: agent.sessionId,
        path: workspace.path,
        hostId: LOCAL,
        repo: workspace.project ?? workspace.name,
        workspace: workspace.name,
        worktreeId,
      }));
    });
    const tree = buildTree(agents, await cards.build(agents, Date.now()));
    return {
      hosts: tree.map((host) => ({
        ...host,
        projects: host.projects.map((project) => ({
          ...project,
          workspaces: project.workspaces.map((workspace) => ({
            ...workspace,
            // card-model.js is untyped JS: CardView names the shape it returns
            cards: workspace.cards.map((card) => cardModel(card, { home }) as CardView),
          })),
        })),
      })),
      focused,
    };
  });
}
