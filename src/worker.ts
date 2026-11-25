// The plugin's own worker: answers the panel with the tree of the Orca agents on every Orca host
// (src/protocol.ts). Each request lists the Orca workspaces and, for those on this computer and
// on SSH hosts, the agents in each; for each paired Orca server `orca environment list` lists it
// lists that server's agents with the `orca` CLI (src/hosts.ts), as Orca's `workspace.list` lists
// no paired server's workspace. It builds their cards from the harnesses' session files, another
// host's read over `ssh` (src/agent-cards.ts), and groups them into the tree (src/tree.ts), from
// that one agent list. The CLI runs on each request, so only while the panel is open, and for
// the palette command `spyhop.show`, which shows the panel. A card's Focus pane button asks it
// to focus the card's pane (`spyhop.focus`) in this computer's Orca window: an agent on this
// computer or an SSH workspace by Orca's `terminal.focus`, one on a paired Orca server by
// `orca terminal switch` to the server's terminal; neither runs anything over ssh. A press that
// cannot focus answers `focused: false` and writes the reason to the worker's log.
import { homedir } from 'node:os';
import type { OrcaWorkerApi } from 'orca/worker';
import { createAgentCards, type OrcaAgent } from './agent-cards.ts';
import { cardModel } from './core/card-model.js';
import { createTtlCache } from './core/ttl-cache.js';
import { run } from './exec.ts';
import { orca as cli, type HostLists, listHosts, readServerAgents, remoteHosts } from './hosts.ts';
import type { CardView, Pane, TreeAnswer } from './protocol.ts';
import { buildTree, type TreeAgent, workspaceRowId } from './tree.ts';
import { worktreeId } from './worktree-id.ts';

// Orca's id of this computer's host; a workspace that records no host is on this computer.
const LOCAL = 'local';
// How long Orca's lists of hosts and paired servers are kept: a server is paired seldom, its
// agents change each refresh.
const HOST_LISTS_TTL_MS = 60 * 1000;

export default function activate(orca: OrcaWorkerApi): void {
  const home = homedir();
  // kept for the worker's life: it keeps the state of its session reads between builds
  const cards = createAgentCards({ run, home });
  const hostLists = createTtlCache(HOST_LISTS_TTL_MS);

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
    const [{ workspaces }, context, listed] = await Promise.all([
      orca.host.call('workspace.list'),
      orca.host.call('workspace.readContext'),
      hostLists('hosts', Date.now(), () => listHosts(run)) as Promise<HostLists>,
    ]);
    const hostOf = (workspace: (typeof workspaces)[number]) => workspace.hostId ?? LOCAL;
    // A paired server's agents come from its own `orca agent list`; the others' workspaces are
    // asked here. `agents.list` lists one workspace's agents. Its `sessionId` is the harness's
    // own session id (what `agent.resume` takes), so a card links by it
    // (src/core/session-link.js). A workspace whose agents cannot be listed (removed since
    // `workspace.list`) shows none, and the others are drawn.
    const asked = workspaces.filter((workspace) => !hostOf(workspace).startsWith('runtime:'));
    const remote = remoteHosts(listed, [...new Set(asked.map(hostOf).filter((hostId) => hostId !== LOCAL))]);
    const [lists, servers] = await Promise.all([
      Promise.all(
        asked.map((workspace) =>
          orca.host.call('agents.list', { workspaceId: workspace.id }).catch(() => ({ agents: [] })),
        ),
      ),
      Promise.all(
        [...remote]
          .filter(([hostId]) => hostId.startsWith('runtime:'))
          .map(([hostId, host]) => readServerAgents(run, hostId, host, (message) => orca.log(message))),
      ),
    ]);
    const onServers = servers.flat();
    // The focused workspace is a `workspace.list` row, or else a paired server's: Orca's id of a
    // workspace is its worktreeId, which that server's agents in it carry.
    const current = workspaces.find((workspace) => workspace.id === context?.workspaceId);
    const onServer = context?.workspaceId ? onServers.find((agent) => agent.worktreeId === context.workspaceId) : undefined;
    const focused = current
      ? workspaceRowId(hostOf(current), worktreeOf(current))
      : onServer
        ? workspaceRowId(onServer.hostId, onServer.worktreeId)
        : null;
    // agent id -> its pane, for an agent Orca names a terminal of
    const panes = new Map<string, Pane>();
    const agents: (OrcaAgent & TreeAgent)[] = asked.flatMap((workspace, i) => {
      const hostId = hostOf(workspace);
      return lists[i].agents.map((agent, n) => {
        const id = `${workspace.id}\0${agent.terminalId ?? n}`;
        if (agent.terminalId) panes.set(id, { terminalId: agent.terminalId });
        return {
          id,
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
        };
      });
    });
    agents.push(...onServers);
    for (const agent of onServers) if (agent.pane) panes.set(agent.id, agent.pane);
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
            // card-model.js is untyped JS: CardView names the shape it returns. A card's id is
            // that of the first of the agents that share it (src/agent-cards.ts).
            cards: workspace.cards.map((card) => ({ ...(cardModel(card, { home }) as Omit<CardView, 'pane'>), pane: panes.get(card.id) ?? null })),
          })),
        })),
      })),
      focused,
    };
  });

  orca.panels.handle('spyhop.focus', async (pane: Pane) => {
    try {
      if ('environment' in pane) {
        // `navigated` false: no desktop here shows that server; an answer without it focused nothing
        const { focus } = await cli(run, ['terminal', 'switch', '--environment', pane.environment, '--terminal', pane.terminal]);
        const focused = focus?.navigated === true;
        if (!focused) orca.log(`spyhop: no Orca window here shows ${pane.environment}: did not navigate to the terminal ${pane.terminal}`);
        return { focused };
      }
      const { focused } = await orca.host.call('terminal.focus', { terminalId: pane.terminalId });
      if (!focused) orca.log(`spyhop: Orca did not focus the terminal ${pane.terminalId}`);
      return { focused };
    } catch (error) {
      const terminal = 'environment' in pane ? `${pane.terminal} of ${pane.environment}` : pane.terminalId;
      orca.log(`spyhop: cannot focus the terminal ${terminal}: ${(error as Error).message}`);
      return { focused: false };
    }
  });
}

// The worktreeId of a `workspace.list` row, its repoId the Orca project's id.
const worktreeOf = (workspace: { id: string; projectId?: string | null; path: string }) =>
  worktreeId(workspace.projectId ?? workspace.id, workspace.path);
