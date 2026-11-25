// The cards of Orca agents, on this computer and on other Orca hosts: one card per harness
// session an agent links to, and one per agent that links to none, whatever its state, in the
// card shape of the core's card model (src/core/card-model.js). Each card holds what Orca says of
// the agent (its harness, state and title, the folder of its workspace), the git facts of that
// folder and the stats of the harness session the agent links to. Every program runs through
// `run` (src/exec.ts), read-only, on the agent's host (`on`: its ssh alias); whatever cannot be
// read, an unreachable host included, shows as n/a on the agent's card, and a build never
// rejects.

import { GIT_TTL_MS, readGit } from './core/git.js';
import { NA, createSessions, readStats } from './core/providers/index.js';
import { collapseBySession, linkAgents } from './core/session-link.js';
import { createTtlCache } from './core/ttl-cache.js';
import type { Run } from './exec.ts';

// An agent as Orca reports it (`agents.list` of the worker host API, `orca agent list --json`),
// with the path of its workspace folder; `id` is the one the caller names the agent by.
// `machine`: the ssh alias of the Orca host it is on, null or absent for this computer.
export type OrcaAgent = {
  id: string;
  agent: string | null;
  state: 'working' | 'blocked' | 'waiting' | 'done';
  title: string | null;
  sessionId?: string | null;
  path: string | null;
  machine?: string | null;
};

// The core's provider of an Orca agent kind, and the name a card gives the harness; a kind
// without a provider is named as Orca names it.
const PROVIDERS: Record<string, string> = { omp: 'omp', claude: 'claude-code', opencode: 'opencode' };
const HARNESS_NAMES: Record<string, string> = { omp: 'omp', claude: 'Claude Code', opencode: 'opencode' };

type Machine = string | null;

// `home`: this computer's home folder.
export function createAgentCards({ run, home }: { run: Run; home: string }) {
  // `run` bound to a machine (null: this computer). ssh exits 255 when it cannot reach the host:
  // the machine's place is then forgotten, so while the host stays down a build costs the one
  // place lookup (see placeOn).
  const execs = new Map<Machine, Run>([[null, run]]);
  function execOn(machine: Machine) {
    if (!execs.has(machine)) {
      execs.set(machine, async (command, args, options) => {
        const result = await run(command, args, { ...options, on: machine });
        if (result.code === 255) places.delete(machine);
        return result;
      });
    }
    return execs.get(machine)!;
  }
  const readTextOn = (machine: Machine) => async (path: string) => {
    const read = await execOn(machine)('cat', ['--', path]);
    return read.code === 0 ? read.stdout : null;
  };

  // machine and folder -> its branch and origin, asked again only after GIT_TTL_MS, so a
  // refresh of known folders runs no git.
  const gits = createTtlCache(GIT_TTL_MS);

  // A machine's operating system, for the `stat` the session listing runs, and its home folder
  // (this computer's is given; another host's is asked): asked once, and again after a failed
  // ask or once the host could not be reached (see execOn).
  const places = new Map<Machine, Promise<{ os: string; home: string }>>();
  function placeOn(machine: Machine) {
    if (!places.has(machine)) {
      const exec = execOn(machine);
      const place = Promise.all([exec('uname', ['-s']), machine ? exec('printenv', ['HOME']) : null]).then(([uname, printenv]) => {
        const machineHome = printenv ? printenv.stdout.trim() : home;
        if (uname.code !== 0 || printenv?.code || !machineHome) throw new Error('machine place unknown');
        return { os: uname.stdout.trim(), home: machineHome };
      });
      place.catch(() => places.delete(machine));
      places.set(machine, place);
    }
    return places.get(machine)!;
  }

  // provider -> its session hook, or null: made once, and kept, since it keeps the per-file
  // state of its session reads between builds
  const hooks = new Map();
  function hookOf(provider: string) {
    if (!hooks.has(provider)) hooks.set(provider, createSessions(provider, { execOn, readTextOn }));
    return hooks.get(provider) ?? null;
  }

  // The session file each agent of one harness, folder and machine links to (null: none), in
  // agent order (see linkAgents, src/core/session-link.js), with that machine's home; never
  // rejects. An agent whose sessionId names a session by its harness's rule (the hook's
  // `named`) gets it, and no title is read for it. The agents left share out the newest
  // sessions no id named, by title, when the hook can `list` the folder; else, and for an agent
  // alone in its folder without a named session, they link to the newest session no id named.
  async function linkAll(agents: OrcaAgent[]) {
    const [{ agent: kind, path, machine = null }] = agents;
    const provider = PROVIDERS[kind ?? ''];
    const hook = provider ? hookOf(provider) : null;
    const none = { home: null, files: agents.map(() => null) };
    if (!hook || !path) return none;
    try {
      const place = await placeOn(machine);
      const where = { machine, cwd: path, ...place };
      const ids = agents.map((agent) => agent.sessionId ?? null);
      const named = ids.some(Boolean) ? await hook.named(where, ids) : ids.map(() => null);
      const except = named.filter(Boolean).map((file: { path: string }) => file.path);
      const unnamed = named.filter((file: unknown) => !file).length;
      let candidates = [];
      if (unnamed > 0 && hook.list && (unnamed > 1 || except.length > 0)) {
        candidates = await hook.list({ ...where, limit: unnamed, except });
      } else if (unnamed > 0) {
        const file = await hook.link({ ...where, except });
        candidates = file ? [file] : [];
      }
      return { home: place.home, files: linkAgents(named, candidates, agents) };
    } catch {
      return none;
    }
  }

  return {
    // The agents' cards, in the order of `agents`, agents that link to one session sharing the
    // card of the first of them. `now`: epoch milliseconds.
    async build(agents: OrcaAgent[], now: number) {
      // harness, folder and machine -> its agents, in agent order
      const groups = new Map<string, OrcaAgent[]>();
      for (const agent of agents) {
        const key = `${agent.agent}\0${agent.path}\0${agent.machine ?? ''}`;
        groups.set(key, [...(groups.get(key) ?? []), agent]);
      }
      const linked = new Map();
      for (const group of groups.values()) {
        const links = linkAll(group);
        group.forEach((agent, i) => linked.set(agent, links.then(({ home, files }) => files[i] && { file: files[i], home })));
      }
      // machine and session path -> its stats, read once for the agents that link to it; the
      // machine is part of the key, since two machines can hold the same path
      const reads = new Map();

      const entries = await Promise.all(
        agents.map(async (agent) => {
          const machine = agent.machine ?? null;
          // asked only once the machine's place is known: a host that cannot be reached costs
          // the one place lookup, and no git runs there
          const readsGit = () =>
            placeOn(machine).then(
              () => readGit({ exec: execOn(machine) }, { cwd: agent.path, on: machine }),
              () => ({ branch: null, origin: null }),
            );
          const [git, link] = await Promise.all([gits(`${machine ?? ''}\0${agent.path}`, now, readsGit), linked.get(agent)]);
          const unlinked = { ...readStats('', null, 0), harness: agent.agent ?? NA };
          const provider = PROVIDERS[agent.agent ?? ''];
          const sessionPath = link ? `${machine ?? ''}\0${link.file.path}` : null;
          if (link && !reads.has(sessionPath)) {
            reads.set(
              sessionPath,
              hookOf(provider)
                .read(link.file, { machine, home: link.home, now })
                .then((input: unknown) => readStats(provider, input, now))
                .catch(() => unlinked),
            );
          }
          const card = {
            id: agent.id,
            folder: agent.path,
            branch: git.branch,
            origin: git.origin,
            harness: agent.agent,
            harnessName: HARNESS_NAMES[agent.agent ?? ''] ?? agent.agent ?? NA,
            title: agent.title,
            status: agent.state,
            machine,
            stats: link ? await reads.get(sessionPath) : unlinked,
          };
          return { sessionPath, card };
        }),
      );
      return collapseBySession(entries).map((entry: (typeof entries)[number]) => entry.card);
    },
  };
}
