// The Orca hosts other than this computer, as the `orca` CLI tells of them: an SSH host (a
// `workspace.list` hostId `ssh:<target id>`) and a paired Orca server (`runtime:<environment
// id>`, every one `orca environment list` lists), each with the name its group shows and the
// alias `ssh` reaches it by, and the Orca agents of a paired server with their panes. Only the
// CLI's list commands run here, through `run` (src/exec.ts) on this computer; whatever cannot be
// listed is left out or named by its id, never rejected. `orca` is also how the worker's palette
// command asks Orca to show the panel, and how it switches to a paired server's terminal.
import type { Run, RunResult } from './exec.ts';
import type { FleetAgent } from './fleet.ts';
import type { Pane } from './protocol.ts';
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

// An Orca host whose harness sessions the catch-up reads (src/history/catch-up.ts): its name and
// its alias, as `remoteHosts` gives them. The catch-up keys its rows by the machine the alias
// reaches.
export type HistoryHost = { name: string; alias: string };

// Every SSH host `lists` names and every paired Orca server, one per alias, in the lists' order,
// the SSH hosts first: a paired server deployed over a listed SSH target shares its alias, which
// is asked once, as the SSH host's.
export function historyHosts(lists: HostLists): HistoryHost[] {
  const sshIds = lists.hosts.filter((host) => host.kind === 'ssh').map((host) => `ssh:${host.id}`);
  const byAlias = new Map<string, HistoryHost>();
  for (const [, { name, alias }] of [...remoteHosts(lists, sshIds)].sort(([a], [b]) => Number(b.startsWith('ssh:')) - Number(a.startsWith('ssh:')))) {
    if (!byAlias.has(alias)) byAlias.set(alias, { name, alias });
  }
  return [...byAlias.values()];
}

// An Orca host's place, from what `uname -s` (or `uname -sn`) and, on another host, `printenv
// HOME` answered there: its operating system, for the `stat` a session listing runs, its node
// name lowercased, '' when `uname` printed none, and its home folder, `home` when given (this
// computer's, where `printenv` is null). Throws when either program failed or the home is empty.
// Each caller runs the programs as it schedules its own.
export function placeOf(uname: RunResult, printenv: RunResult | null, home: string | null): { os: string; node: string; home: string } {
  const found = printenv ? printenv.stdout.trim() : home;
  if (uname.code !== 0 || printenv?.code || !found) throw new Error('machine place unknown');
  const [os, node = ''] = uname.stdout.trim().split(/\s+/);
  return { os, node: node.toLowerCase(), home: found };
}

// An Orca agent of a paired server, in the server's group, with its pane, if any.
export type ServerAgent = FleetAgent & { pane: Pane | null };

// The Orca agents of the paired server `hostId` (`orca agent list --environment <name>`), in its
// group and read over its alias; none when the server cannot be listed, or answers anything
// but a list of agents. The server reports them on its own `local` host, which is not this
// computer's. An agent's pane (`tabId:leafId`, its paneKey) is the server's terminal `orca
// terminal list` lists in that tab and leaf; none when no listed terminal is, or the terminals
// cannot be listed. The server lists at most 200 terminals by default; a list it cut short is
// written to `log`, and the terminals past it give no pane and no title. An agent the server
// lists without a title, as the paired server starfish-bs lists a live omp agent, takes the
// title of its pane's terminal, which carries omp's session title: omp's link by title needs it
// (src/core/session-link.js). An agent's `stateSince` is its `updatedAt`, which the server gives
// as epoch ms or as an ISO text: none when it gives neither. An agent's folder is the path of its
// worktreeId; none when that is no absolute path, which no folder is read at.
export async function readServerAgents(
  run: Run,
  hostId: string,
  host: RemoteHost,
  log: (message: string) => void,
): Promise<ServerAgent[]> {
  const environment = ['--environment', host.name];
  try {
    const [listed, terminals] = await Promise.all([
      orca(run, ['agent', 'list', ...environment]).then(({ agents }) => (agents ?? []) as Listed[]),
      orca(run, ['terminal', 'list', ...environment])
        .then(({ terminals = [], truncated, totalCount }) => {
          if (truncated) log(`spyhop: ${host.name} listed ${terminals.length} of ${totalCount} terminals: agents in the others have no pane to focus`);
          return new Map((terminals as Listed[]).map((terminal) => [`${terminal.tabId}:${terminal.leafId}`, terminal]));
        })
        .catch(() => new Map<string, Listed>()),
    ]);
    return listed.map((agent, n) => {
      const terminal = agent.paneKey ? terminals.get(agent.paneKey) : undefined;
      const handle = terminal?.handle as string | undefined;
      return {
        id: `${hostId}\0${agent.paneKey ?? n}`,
        agent: agent.agent ?? null,
        state: agent.state,
        title: agent.title ?? terminal?.title ?? null,
        stateSince: stateSinceOf(agent.updatedAt),
        // `orcaSessionId` is Orca's id, not the harness's
        sessionId: null,
        path: folderOf(agent.worktreeId),
        machine: host.alias,
        hostId,
        // Orca's id of a paired server's workspace is its worktreeId
        workspaceId: agent.worktreeId,
        pane: handle ? { environment: host.name, terminal: handle } : null,
      };
    });
  } catch {
    return [];
  }
}

// The absolute path the worktreeId `id` holds, null when it holds none.
function folderOf(id: string): string | null {
  const path = splitWorktreeId(id)?.path;
  return path?.startsWith('/') ? path : null;
}

// epoch ms of an `updatedAt` of `orca agent list`, null when it is neither a number nor a date text
function stateSinceOf(updatedAt: unknown): number | null {
  if (typeof updatedAt === 'number') return updatedAt;
  const time = typeof updatedAt === 'string' ? Date.parse(updatedAt) : Number.NaN;
  return Number.isNaN(time) ? null : time;
}
