// The plugin's own worker: answers the panel with the tree of the Orca agents on every Orca host
// (src/protocol.ts). Each request lists the Orca workspaces and, for those on this computer and
// on SSH hosts, the agents in each; for each paired Orca server among the workspaces' hosts it
// lists that server's agents with the `orca` CLI (src/hosts.ts). It builds their cards from the
// harnesses' session files, another host's read over `ssh` (src/agent-cards.ts), and groups them
// into the tree (src/tree.ts), from that one agent list. The CLI runs only when a workspace is
// on another host, and for the palette command `spyhop.show`, which shows the panel.
import { homedir } from 'node:os';
import type { OrcaWorkerApi } from 'orca/worker';
import { createAgentCards, type OrcaAgent } from './agent-cards.ts';
import { cardModel } from './core/card-model.js';
import { run } from './exec.ts';
import { orca as cli, readRemoteHosts, readServerAgents } from './hosts.ts';
import type { CardView, TreeAnswer } from './protocol.ts';
import { buildTree, type TreeAgent, workspaceRowId } from './tree.ts';
import { worktreeId } from './worktree-id.ts';

// Orca's id of this computer's host; a workspace that records no host is on this computer.
const LOCAL = 'local';

export default function activate(orca: OrcaWorkerApi): void {
  const home = homedir();
  // kept for the worker's life: it keeps the state of its session reads between builds
  const cards = createAgentCards({ run, home });

  // Orca gives a plugin no call that shows its own panel; its CLI does, by the key Orca installed
  // the plugin under (`local.spyhop` from a folder, `<owner>.spyhop` from Git): the listed one
  // that contributes the panel `spyhop`. The command runs in its worker, so it is enabled.
  orca.commands.register('spyhop.show', async () => {
    const { plugins } = await cli(run, ['plugin', 'list']);
    const self = plugins.find(
      (plugin: { pluginKey: string; panels?: { id: string }[] }) =>
        plugin.pluginKey.endsWith('.spyhop') && plugin.panels?.some((panel) => panel.id === 'spyhop'),
    );
    if (!self) throw new Error('Orca lists no spyhop plugin');
    await cli(run, ['plugin', 'open', self.pluginKey, '--panel', 'spyhop']);
  });

  orca.panels.handle('spyhop.tree', async (): Promise<TreeAnswer> => {
    const [{ workspaces }, context] = await Promise.all([
      orca.host.call('workspace.list'),
      orca.host.call('workspace.readContext'),
    ]);
    const hostOf = (workspace: (typeof workspaces)[number]) => workspace.hostId ?? LOCAL;
    const remoteIds = [...new Set(workspaces.map(hostOf).filter((hostId) => hostId !== LOCAL))];
    const remote = remoteIds.length > 0 ? await readRemoteHosts(run, remoteIds) : new Map();
    // A paired server's agents come from its own `orca agent list`; the others' workspaces are
    // asked here. `agents.list` lists one workspace's agents. Its `sessionId` is the harness's
    // own session id (what `agent.resume` takes), so a card links by it
    // (src/core/session-link.js). A workspace whose agents cannot be listed (removed since
    // `workspace.list`) shows none, and the others are drawn.
    const asked = workspaces.filter((workspace) => !hostOf(workspace).startsWith('runtime:'));
    const [lists, servers] = await Promise.all([
      Promise.all(
        asked.map((workspace) =>
          orca.host.call('agents.list', { workspaceId: workspace.id }).catch(() => ({ agents: [] })),
        ),
      ),
      Promise.all(
        remoteIds
          .filter((hostId) => hostId.startsWith('runtime:'))
          .map((hostId) => readServerAgents(run, hostId, remote.get(hostId))),
      ),
    ]);
    const current = workspaces.find((workspace) => workspace.id === context?.workspaceId);
    const focused = current ? workspaceRowId(hostOf(current), worktreeOf(current)) : null;
    const agents: (OrcaAgent & TreeAgent)[] = asked.flatMap((workspace, i) => {
      const hostId = hostOf(workspace);
      return lists[i].agents.map((agent, n) => ({
        id: `${workspace.id}\0${agent.terminalId ?? n}`,
        agent: agent.agent,
        state: agent.state,
        title: agent.title,
        sessionId: agent.sessionId,
        path: workspace.path,
        machine: remote.get(hostId)?.alias ?? null,
        hostId,
        repo: workspace.project ?? workspace.name,
        workspace: workspace.name,
        worktreeId: worktreeOf(workspace),
      }));
    });
    agents.push(...servers.flat());
    const tree = buildTree(agents, await cards.build(agents, Date.now()));
    return {
      hosts: tree.map((host) => ({
        ...host,
        // as Orca names the host: `local` for this computer
        name: remote.get(host.id)?.name ?? host.name,
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

// The worktreeId of a `workspace.list` row, its repoId the Orca project's id.
const worktreeOf = (workspace: { id: string; projectId?: string | null; path: string }) =>
  worktreeId(workspace.projectId ?? workspace.id, workspace.path);
