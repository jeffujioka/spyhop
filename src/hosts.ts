// The Orca hosts other than this computer, as the `orca` CLI tells of them: an SSH host (a
// `workspace.list` hostId `ssh:<target id>`) and a paired Orca server (`runtime:<environment
// id>`), each with the name its host row shows and the alias `ssh` reaches it by, and the Orca
// agents of a paired server. Only the CLI's list commands run here, through `run` (src/exec.ts)
// on this computer; whatever cannot be listed is left out or named by its id, never rejected.
// `orca` is also how the worker's palette command asks Orca to show the panel.
import type { OrcaAgent } from './agent-cards.ts';
import type { Run } from './exec.ts';
import type { TreeAgent } from './tree.ts';
import { splitWorktreeId } from './worktree-id.ts';

// An Orca host's name, as Orca names it, and the alias of its SSH target.
export type RemoteHost = { name: string; alias: string };

type Listed = Record<string, any>;

// What `orca <args> --json` answers (`{ ok, result }`): its result. The CLI is the one Orca's
// guide names: ORCA_CLI_COMMAND when set, else `orca` on PATH.
export async function orca(run: Run, args: string[]): Promise<Listed> {
  const { code, stdout } = await run(process.env.ORCA_CLI_COMMAND || 'orca', [...args, '--json']);
  if (code !== 0) throw new Error(`orca ${args.join(' ')} failed`);
  return JSON.parse(stdout).result;
}

// The hosts `hostIds` name (each `ssh:…` or `runtime:…`), by hostId. An SSH host is named by its
// SSH target's name, which is its alias; a paired server by its environment's name, its alias
// being the name of the SSH target its `orcadDeployment.sshTargetId` names. A host the CLI does
// not list is named by its id, as is its alias.
export async function readRemoteHosts(run: Run, hostIds: string[]): Promise<Map<string, RemoteHost>> {
  const [hosts, environments] = await Promise.all([
    orca(run, ['host', 'list']).then((result) => (result.hosts ?? []) as Listed[], () => []),
    hostIds.some((id) => id.startsWith('runtime:'))
      ? orca(run, ['environment', 'list']).then((result) => (result.environments ?? []) as Listed[], () => [])
      : [],
  ]);
  const targets = new Map(hosts.filter((host) => host.kind === 'ssh').map((host) => [host.id, host.name as string]));
  const servers = new Map(environments.map((environment) => [environment.id, environment]));
  return new Map(
    hostIds.map((hostId) => {
      const id = hostId.slice(hostId.indexOf(':') + 1);
      if (hostId.startsWith('ssh:')) {
        const name = targets.get(id) ?? id;
        return [hostId, { name, alias: name }];
      }
      const server = servers.get(id);
      const name: string = server?.name ?? id;
      return [hostId, { name, alias: targets.get(server?.orcadDeployment?.sshTargetId) ?? name }];
    }),
  );
}

// The Orca agents of the paired server `hostId` (`orca agent list --environment <name>`), on its
// host row and read over its alias; none when the server cannot be listed. The server reports
// them on its own `local` host, which is not this computer's.
export async function readServerAgents(run: Run, hostId: string, host: RemoteHost): Promise<(OrcaAgent & TreeAgent)[]> {
  try {
    const { agents } = await orca(run, ['agent', 'list', '--environment', host.name]);
    return (agents as Listed[]).map((agent, n) => ({
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
    }));
  } catch {
    return [];
  }
}
