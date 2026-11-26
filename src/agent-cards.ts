// The cards of Orca agents, on this computer and on other Orca hosts: one card per harness
// session an agent links to, and one per agent that links to none, whatever its state, in the
// card shape of the core's card model (src/core/card-model.js). Each card holds what Orca says of
// the agent (its harness, state and title), the stats of the harness session the agent links
// to, the folder that session records as its own (the folder of the agent's workspace when it
// links to none, or its session tells none) and the git facts of that folder. Every program
// runs through `run` (src/exec.ts), read-only, on the agent's host (`on`: its ssh alias);
// whatever cannot be read, an unreachable host included, shows as n/a on the agent's card, and
// a build never rejects.

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

// Whether `agents` are the agents `before`, but for their states: the same ids in the same order,
// each with the same harness, folder, machine, session id and title, so that both build the same
// cards, but for the status of each.
export function sameButStates(before: OrcaAgent[], agents: OrcaAgent[]) {
  return (
    before.length === agents.length &&
    before.every((was, i) => {
      const now = agents[i];
      return (
        was.id === now.id &&
        was.agent === now.agent &&
        was.path === now.path &&
        (was.machine ?? null) === (now.machine ?? null) &&
        (was.sessionId ?? null) === (now.sessionId ?? null) &&
        was.title === now.title
      );
    })
  );
}

// The core's provider of an Orca agent kind, and the name a card gives the harness; a kind
// without a provider is named as Orca names it.
const PROVIDERS: Record<string, string> = { omp: 'omp', claude: 'claude-code', opencode: 'opencode' };
const HARNESS_NAMES: Record<string, string> = { omp: 'omp', claude: 'Claude Code', opencode: 'opencode' };

type Machine = string | null;

// A finished scan of a session file, kept between runs of the worker (src/core/refresh.js): the
// provider's totals `state` over the file's first `pos` bytes.
export type KeptScan = { provider: string; machine: Machine; path: string; pos: number; state: unknown };

// `home`: this computer's home folder. `kept`: the scans an earlier run kept, which the session
// reads of those files start from.
export function createAgentCards({ run, home, kept = [] }: { run: Run; home: string; kept?: KeptScan[] }) {
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

  // machine and folder (a card's: the one its session records, else its workspace's) -> its
  // branch and origin, asked again only after GIT_TTL_MS, so a refresh of known folders runs
  // no git.
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
    if (!hooks.has(provider)) {
      hooks.set(provider, createSessions(provider, { execOn, readTextOn, kept: kept.filter((scan) => scan.provider === provider) }));
    }
    return hooks.get(provider) ?? null;
  }

  // The session file each agent of one harness, folder and machine links to (null: none), in
  // agent order, with that machine's home; never rejects. An agent whose sessionId names a
  // session by its harness's rule (the hook's `named`) gets it, whatever folder of the host
  // that session is of, and no title is read for it. The agents left link by their harness's
  // rule. A hook that can `list` (omp, whose sessions carry a title): each to the session of
  // the workspace folder or below it whose title its own contains, and to none when no title
  // matches (see linkAgents, src/core/session-link.js). A hook that cannot (Claude Code,
  // opencode): all to the newest session of the workspace folder no id named (`link`).
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
      if (named.every(Boolean)) return { home: place.home, files: named };
      if (hook.list) return { home: place.home, files: linkAgents(named, await hook.list({ ...where, except }), agents) };
      const newest = await hook.link({ ...where, except });
      return { home: place.home, files: named.map((file: unknown) => file ?? newest) };
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
      // machine and session path -> its stats and the folder it records (null: untold), read
      // once for the agents that link to it; the machine is part of the key, since two machines
      // can hold the same path
      const reads = new Map();

      const entries = await Promise.all(
        agents.map(async (agent) => {
          const machine = agent.machine ?? null;
          const provider = PROVIDERS[agent.agent ?? ''];
          // the lookup the link waits for too: taken before the link, since a failed one is
          // forgotten, and asking again after it would cost a dead host a second lookup. An
          // agent that links to no session (no provider, no folder) asks it where git is read,
          // whose answer is kept: a dead host of such agents is not asked at every build.
          const placed = provider && agent.path ? placeOn(machine) : null;
          const link = await linked.get(agent);
          const unlinked = { ...readStats('', null, 0), harness: agent.agent ?? NA };
          const sessionPath = link ? `${machine ?? ''}\0${link.file.path}` : null;
          if (link && !reads.has(sessionPath)) {
            const hook = hookOf(provider);
            reads.set(
              sessionPath,
              hook
                .read(link.file, { machine, home: link.home, now })
                .then(async (input: unknown) => {
                  const stats = readStats(provider, input, now);
                  try {
                    return { stats, cwd: (await hook.folder?.(link.file, { machine })) ?? null };
                  } catch {
                    // a folder that cannot be asked is untold, and the stats stay
                    return { stats, cwd: null };
                  }
                })
                .catch(() => ({ stats: unlinked, cwd: null })),
            );
          }
          const session = link ? await reads.get(sessionPath) : { stats: unlinked, cwd: null };
          const folder = session.cwd ?? agent.path;
          // asked only once the machine's place is known: a host that cannot be reached costs
          // the one place lookup, and no git runs there
          const readsGit = () =>
            (placed ?? placeOn(machine)).then(
              () => readGit({ exec: execOn(machine) }, { cwd: folder, on: machine }),
              () => ({ branch: null, origin: null }),
            );
          const git = await gits(`${machine ?? ''}\0${folder}`, now, readsGit);
          const card = {
            id: agent.id,
            folder,
            branch: git.branch,
            origin: git.origin,
            harness: agent.agent,
            harnessName: HARNESS_NAMES[agent.agent ?? ''] ?? agent.agent ?? NA,
            title: agent.title,
            status: agent.state,
            machine,
            stats: session.stats,
          };
          return { sessionPath, card };
        }),
      );
      return collapseBySession(entries).map((entry: (typeof entries)[number]) => entry.card);
    },

    // The finished scans of the session files read since this builder was made, to keep for a
    // later run, and whether any changed since this was last asked. Their states are the
    // readers' own, which a later build changes: encode them at once.
    scanned() {
      const all: { changed: boolean; scans: KeptScan[] } = { changed: false, scans: [] };
      for (const [provider, hook] of hooks) {
        // a provider that reads no session file (opencode) has no scan
        const { changed, scans } = hook?.scanned?.() ?? { changed: false, scans: [] };
        all.changed ||= changed;
        for (const scan of scans) all.scans.push({ provider, ...scan });
      }
      return all;
    },
  };
}
