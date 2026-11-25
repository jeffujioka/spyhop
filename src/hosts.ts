// The Orca hosts other than this computer, as the `orca` CLI tells of them: an SSH host (a
// `workspace.list` hostId `ssh:<target id>`) and a paired Orca server (`runtime:<environment
// id>`, every one `orca environment list` lists), each with the name its host row shows and the
// alias `ssh` reaches it by, and the Orca agents of a paired server with their panes. Only the
// CLI's list commands run here, through `run` (src/exec.ts) on this computer; whatever cannot be
// listed is left out or named by its id, never rejected. `orca` is also how the worker's palette
// command asks Orca to show the panel, and how it switches to a paired server's terminal.
import type { OrcaAgent } from './agent-cards.ts';
import type { Run } from './exec.ts';
import type { Pane } from './protocol.ts';
import type { TreeAgent } from './tree.ts';
import { splitWorktreeId } from './worktree-id.ts';

// An Orca host's name, as Orca names it, and the alias of its SSH target.
export type RemoteHost = { name: string; alias: string };

type Listed = Record<string, any>;

// What `orca <args> --json` answers (`{ ok, result }`): its result; a failure rejects with what
// the CLI printed of it. The CLI is the one Orca's guide names: ORCA_CLI_COMMAND when set, else
// `orca` on PATH.
export async function orca(run: Run, args: string[]): Promise<Listed> {
  const { code, stdout, stderr } = await run(process.env.ORCA_CLI_COMMAND || 'orca', [...args, '--json']);
  if (code !== 0) throw new Error(`orca ${args.join(' ')} failed: ${(stderr || stdout).trim()}`);
  return JSON.parse(stdout).result;
}

// What `orca host list` and `orca environment list` list: Orca's hosts, and the environments of
// its paired Orca servers; each none when it cannot be listed.
export type HostLists = { hosts: Listed[]; environments: Listed[] };

export async function listHosts(run: Run): Promise<HostLists> {
  const [hosts, environments] = await Promise.all([
    orca(run, ['host', 'list']).then((result) => (result.hosts ?? []) as Listed[], () => []),
    orca(run, ['environment', 'list']).then((result) => (result.environments ?? []) as Listed[], () => []),
  ]);
  return { hosts, environments };
}

// By hostId, every paired Orca server `lists` names and the hosts `hostIds` name (each `ssh:…`).
// A paired server is named by its environment's name, its alias being the name of the SSH target
// its `orcadDeployment.sshTargetId` names; an SSH host by its SSH target's name, which is its
// alias. A host the lists do not name is named by its id, as is its alias.
export function remoteHosts({ hosts, environments }: HostLists, hostIds: string[]): Map<string, RemoteHost> {
  const targets = new Map(hosts.filter((host) => host.kind === 'ssh').map((host) => [host.id, host.name as string]));
  const remote = new Map<string, RemoteHost>(
    environments.map((environment) => {
      const name: string = environment.name ?? environment.id;
      return [`runtime:${environment.id}`, { name, alias: targets.get(environment.orcadDeployment?.sshTargetId) ?? name }];
    }),
  );
  for (const hostId of hostIds) {
    if (remote.has(hostId)) continue;
    const id = hostId.slice(hostId.indexOf(':') + 1);
    const name = (hostId.startsWith('ssh:') && targets.get(id)) || id;
    remote.set(hostId, { name, alias: name });
  }
  return remote;
}

// The Orca agents of the paired server `hostId` (`orca agent list --environment <name>`), on its
// host row and read over its alias; none when the server cannot be listed, or answers anything
// but a list of agents. The server reports them on its own `local` host, which is not this
// computer's. An agent's pane (`tabId:leafId`, its paneKey) is the server's terminal `orca
// terminal list` lists in that tab and leaf; none when no listed terminal is, or the terminals
// cannot be listed. The server lists at most 200 terminals by default; a list it cut short is
// written to `log`, and the terminals past it give no pane.
export async function readServerAgents(
  run: Run,
  hostId: string,
  host: RemoteHost,
  log: (message: string) => void,
): Promise<(OrcaAgent & TreeAgent & { pane: Pane | null })[]> {
  const environment = ['--environment', host.name];
  try {
    const [listed, handles] = await Promise.all([
      orca(run, ['agent', 'list', ...environment]).then(({ agents }) => (agents ?? []) as Listed[]),
      orca(run, ['terminal', 'list', ...environment])
        .then(({ terminals = [], truncated, totalCount }) => {
          if (truncated) log(`spyhop: ${host.name} listed ${terminals.length} of ${totalCount} terminals: agents in the others show no Focus pane`);
          return new Map((terminals as Listed[]).map((terminal) => [`${terminal.tabId}:${terminal.leafId}`, terminal.handle as string]));
        })
        .catch(() => new Map<string, string>()),
    ]);
    return listed.map((agent, n) => {
      const handle = agent.paneKey && handles.get(agent.paneKey);
      return {
        id: `${hostId}\0${agent.paneKey ?? n}`,
        agent: agent.agent ?? null,
        state: agent.state,
        title: agent.title ?? null,
        // `orcaSessionId` is Orca's id, not the harness's
        sessionId: null,
        path: splitWorktreeId(agent.worktreeId)?.path ?? null,
        machine: host.alias,
        hostId,
        repo: agent.repo,
        workspace: agent.workspace,
        worktreeId: agent.worktreeId,
        pane: handle ? { environment: host.name, terminal: handle } : null,
      };
    });
  } catch {
    return [];
  }
}
