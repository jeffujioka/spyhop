// The cards of Orca agents, on this computer and on other Orca hosts: one card per harness
// session the agents of one workspace folder link to, and one per agent that links to none,
// whatever its state (BuiltCard, which src/card-view.ts turns into what the panel draws).
// Each card holds what Orca says of the agent (its harness, state and title), the stats of the
// harness session the agent links to, the folder that session records as its own (the folder
// of the agent's workspace when it links to none, or its session tells none) and the git facts
// of that folder. Every program runs through `run` (src/exec.ts), read-only, on the agent's
// host (`on`: its ssh alias); whatever cannot be read, an unreachable host included, shows as
// n/a on the agent's card, and a build never rejects.

import { withoutTitleMark } from './core/format.js';
import { GIT_TTL_MS, readGit } from './core/git.js';
import { NA, createSessions, readStats } from './core/providers/index.js';
import { collapseBySession, linkAgents } from './core/session-link.js';
import { createTtlCache } from './core/ttl-cache.js';
import type { Run } from './exec.ts';
import { placeOf } from './hosts.ts';
import type { Num, Point } from './protocol.ts';

// An agent as Orca reports it (`agents.list` of the worker host API, `orca agent list --json`),
// with the path of its workspace folder; `id` is the one the caller names the agent by.
// `machine`: the ssh alias of the Orca host it is on, null or absent for this computer; `hostId`:
// Orca's id of that host, `local` when absent. `stateSince`: when the agent entered its state,
// epoch ms, as Orca gives it; null or absent when Orca gives none.
export type OrcaAgent = {
  id: string;
  agent: string | null;
  state: 'working' | 'blocked' | 'waiting' | 'done';
  title: string | null;
  sessionId?: string | null;
  path: string | null;
  machine?: string | null;
  stateSince?: number | null;
  hostId?: string;
};

// The series and tallies a provider's fold keeps over a whole session file (src/core/series.js):
// the bounded series of model calls, and of side calls (`sides`, omp's; none for another
// harness), the compactions with their tokens before and after (null:
// not logged), the cold starts, the tool calls by tool and the cost (null: not logged) and
// tokens by model, with whether the file's own model calls (`main`) and its side calls (`side`)
// used it (omp's; another harness's are its own model calls'), the agent kind and the model a
// sub-agent's transcript records of itself (null: none recorded), the times of the file's first
// and last entry (null: none), the sums of its newest minutes (a Minute of src/core/series.js
// each, oldest first), Claude Code's cost, USD, by model of its newest `cost-state` that gives
// one, its sub-agents' included (`costs`; null: none; another harness has none), and the part of
// the file's cost of its Copilot calls, priced from the Copilot price table (`copilotUsd`; omp's
// and opencode's, another harness has none).
export type SessionSeries = {
  points: Point[];
  sides: Point[];
  marks: { t: number; before: number | null; after: number | null }[];
  cold: { count: number; tokens: number; cost: number | null };
  tools: Record<string, { calls: number; failed: number }>;
  models: Record<string, { cost: number | null; tokens: number; main?: boolean; side?: boolean }>;
  kind: string | null;
  model: string | null;
  start: number | null;
  end: number | null;
  minutes: Minute[];
  costs?: Record<string, number> | null;
  copilotUsd?: number;
};

// The model calls of one epoch minute `m` (src/core/series.js): their cost (null once one logged
// none), their tokens in all, and the prompt tokens they read from the cache, wrote to it and sent
// uncached.
export type Minute = { m: number; cost: number | null; tokens: number; read: number; write: number; uncached: number };

// The stats of a card's session, as `readStats` (src/core/providers/index.js) gives them: every
// field of STAT_FIELDS, n/a where it cannot be read, and `detail`, null unless the session file
// was read whole: the contexts after its last model calls, and its series, but for an opencode
// session whose tool calls cannot be read. The fields the panels' TypeScript reads are named.
export type CardStats = {
  [field: string]: unknown;
  model: string;
  durationMs: Num;
  costUsd: Num;
  totalTokens: Num;
  premiumRequests: Num;
  contextTokens: Num;
  contextMax: Num;
  contextPercent: Num;
  headroomTokens: Num;
  cacheLeftMs: Num;
  cacheHitRate: Num;
  latencyMs: Num;
  thinkingLevel: string;
  calls: Num;
  firstMessageMs: Num;
  detail: { recent: number[] } | ({ recent: number[] } & SessionSeries) | null;
};

// A sub-agent of a session as a provider's `subagents` hook gives it (src/core/providers/index.js):
// its name, its agent kind, model and task (null: not told), whether it runs (null: the harness
// does not tell), and the `input` of `readStats` for its transcript, null when it was not read.
export type SubAgentInput = { name: string; kind: string | null; model: string | null; task: string | null; running: boolean | null; input: unknown | null };

// A card as `build` returns it. `agents`: the ids of the agents that share it, in the order of
// the agents, the first being the card's own `id`. `linked`: whether its agent links to a
// session, `file` its main session file's path (opencode's: its session id), null without one;
// `hostId`: Orca's id of the agent's host. `folder`: the one its session records, else its
// workspace's; `harness`: Orca's kind
// of the agent, `harnessName` the name a card gives it; `status`: the agent's Orca state;
// `stateSince`: the agent's. `subAgents`: the sub-agents of its session, null when the session
// tells none (no session, a provider without sub-agents, a listing that failed with none
// before it; a listing that failed after one that did not gives that one's): how many there
// are, how many of their transcripts are read, and each with the stats of its transcript
// (every figure n/a for one not read), its kind and model taken from those stats where the hook
// told none, and its start and end, the times of its transcript's first and last entry (n/a for
// one not read), in the order they started, those not read last.
export type BuiltCard = {
  id: string;
  agents: string[];
  linked: boolean;
  file: string | null;
  hostId: string;
  folder: string | null;
  branch: string | null;
  origin: string | null;
  harness: string | null;
  harnessName: string;
  title: string | null;
  status: string;
  machine: Machine;
  stateSince: number | null;
  stats: CardStats;
  subAgents: { total: number; read: number; agents: (SubAgentInput & { stats: CardStats; start: Num; end: Num })[] } | null;
};

// Whether `agents` are the agents `before`, but for their states: the same ids in the same order,
// each with the same harness, folder, machine, session id and title, so that both build the same
// cards, but for the status of each. Titles are compared without their mark (withoutTitleMark):
// omp's spinner frame changes every 100 ms while the agent works and changes no card.
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
        withoutTitleMark(was.title, was.agent) === withoutTitleMark(now.title, now.agent)
      );
    })
  );
}

// The core's provider of an Orca agent kind, and the name a card gives the harness; a kind
// without a provider is named as Orca names it. Orca lists opencode's agents as `opencode` or,
// since opencode's current tables, `opencode2`: both are opencode's.
const PROVIDERS: Record<string, string> = { omp: 'omp', claude: 'claude-code', opencode: 'opencode', opencode2: 'opencode' };
export const HARNESS_NAMES: Record<string, string> = { omp: 'omp', claude: 'Claude Code', opencode: 'opencode', opencode2: 'opencode' };

type Machine = string | null;

// A finished scan of a session file, kept between runs of the worker (src/core/refresh.js): the
// provider's totals `state` over the file's first `pos` bytes, when the file was last asked for
// (epoch ms) and whether it is an ended sub-agent's.
export type KeptScan = { provider: string; machine: Machine; path: string; pos: number; state: unknown; readAt?: number; ended?: boolean };

// A session hook as the registry gives it: only what `subAgentsOf` asks of it is named.
type SubAgentsHook = { subagents?: (file: unknown, where: object) => Promise<SubAgentInput[]> };

// The `subAgents` of a card whose session is `file` (see BuiltCard), from its provider's hook;
// null for a hook without `subagents`, and rejected when the hook rejects. Each transcript's
// stats are read with `readStats` as a session's are; one not read has every figure n/a. The
// order is by the start, so one whose start is unknown comes after those that started.
async function subAgentsOf(hook: SubAgentsHook, provider: string, file: unknown, where: object, now: number): Promise<BuiltCard['subAgents']> {
  if (!hook.subagents) return null;
  const inputs = await hook.subagents(file, where);
  const agents = inputs.map((sub) => {
    // readStats is the core's JavaScript, whose result TypeScript reads as an open record:
    // CardStats names its fields
    const read: Record<string, unknown> = sub.input === null ? { ...readStats('', null, now), harness: provider } : readStats(provider, sub.input, now);
    const stats = read as CardStats;
    const detail = stats.detail as Partial<SessionSeries> | null;
    const start: Num = detail?.start ?? NA;
    const end: Num = detail?.end ?? NA;
    return { ...sub, kind: sub.kind ?? detail?.kind ?? null, model: sub.model ?? detail?.model ?? null, stats, start, end };
  });
  // two unknown starts give NaN, which keeps their order
  agents.sort((a, b) => (a.start === NA ? Infinity : a.start) - (b.start === NA ? Infinity : b.start) || 0);
  return { total: agents.length, read: inputs.filter(({ input }) => input !== null).length, agents };
}

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
  // A text file on a machine, or null when `cat` cannot read it (no such file, for one). An ssh
  // failure (exit 255; `cat` itself never exits 255) rejects instead, so that a caller can tell a
  // host it could not reach from a file that is not there.
  const readTextOn = (machine: Machine) => async (path: string) => {
    const read = await execOn(machine)('cat', ['--', path]);
    if (read.code === 255) throw new Error(`cannot reach ${machine} to read ${path}`);
    return read.code === 0 ? read.stdout : null;
  };

  // machine and folder (a card's: the one its session records, else its workspace's) -> its
  // branch and origin, asked again only after GIT_TTL_MS, so a refresh of known folders runs
  // no git.
  const gits = createTtlCache(GIT_TTL_MS);

  // machine and session path -> the session's sub-agents as its last listing that did not fail
  // gave them: a refresh whose listing fails keeps them, since its sub-agents are then unknown,
  // and none would read as a session without any
  const listedSubAgents = new Map<string, BuiltCard['subAgents']>();

  // A machine's place (`placeOf`, src/hosts.ts; this computer's home is given, another host's is
  // asked): asked once, and again after a failed ask or once the host could not be reached (see
  // execOn).
  const places = new Map<Machine, Promise<{ os: string; home: string }>>();
  function placeOn(machine: Machine) {
    if (!places.has(machine)) {
      const exec = execOn(machine);
      const place = Promise.all([exec('uname', ['-s']), machine ? exec('printenv', ['HOME']) : null]).then(([uname, printenv]) => placeOf(uname, printenv, home));
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
    const none = { place: null, files: agents.map(() => null) };
    if (!hook || !path) return none;
    try {
      const place = await placeOn(machine);
      const where = { machine, cwd: path, ...place };
      const ids = agents.map((agent) => agent.sessionId ?? null);
      const named = ids.some(Boolean) ? await hook.named(where, ids) : ids.map(() => null);
      const except = named.filter(Boolean).map((file: { path: string }) => file.path);
      if (named.every(Boolean)) return { place, files: named };
      if (hook.list) return { place, files: linkAgents(named, await hook.list({ ...where, except }), agents) };
      const newest = await hook.link({ ...where, except });
      return { place, files: named.map((file: unknown) => file ?? newest) };
    } catch {
      return none;
    }
  }

  return {
    // The agents' cards, in the order of `agents`, agents of one harness, workspace folder and
    // machine that link to one session sharing the card of the first of them. `now`: epoch
    // milliseconds.
    async build(agents: OrcaAgent[], now: number): Promise<BuiltCard[]> {
      // harness, folder and machine -> its agents, in agent order; Orca's kinds of one provider
      // (opencode's `opencode` and `opencode2`) are one harness
      const groups = new Map<string, OrcaAgent[]>();
      for (const agent of agents) {
        const key = `${PROVIDERS[agent.agent ?? ''] ?? agent.agent}\0${agent.path}\0${agent.machine ?? ''}`;
        groups.set(key, [...(groups.get(key) ?? []), agent]);
      }
      const linked = new Map();
      for (const group of groups.values()) {
        const links = linkAll(group);
        group.forEach((agent, i) => linked.set(agent, links.then(({ place, files }) => files[i] && { file: files[i], place })));
      }
      // machine and session path -> its stats, the folder it records (null: untold) and its
      // sub-agents, read once for the agents that link to it; the machine is part of the key,
      // since two machines can hold the same path
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
                .read(link.file, { machine, home: link.place.home, now })
                .then(async (input: unknown) => {
                  const stats = readStats(provider, input, now);
                  const folderOf = async () => {
                    try {
                      return (await hook.folder?.(link.file, { machine })) ?? null;
                    } catch {
                      // a folder that cannot be asked is untold, and the stats stay
                      return null;
                    }
                  };
                  const where = { machine, ...link.place, now };
                  const subAgentsRead = subAgentsOf(hook, provider, link.file, where, now).then(
                    (subAgents) => {
                      listedSubAgents.set(sessionPath!, subAgents);
                      return subAgents;
                    },
                    () => listedSubAgents.get(sessionPath!) ?? null,
                  );
                  const [cwd, subAgents] = await Promise.all([folderOf(), subAgentsRead]);
                  return { stats, cwd, subAgents };
                })
                .catch(() => ({ stats: unlinked, cwd: null, subAgents: null })),
            );
          }
          const session = link ? await reads.get(sessionPath) : { stats: unlinked, cwd: null, subAgents: null };
          const folder = session.cwd ?? agent.path;
          // asked only once the machine's place is known: a host that cannot be reached costs
          // the one place lookup, and no git runs there
          const readsGit = () =>
            (placed ?? placeOn(machine)).then(
              () => readGit({ exec: execOn(machine) }, { cwd: folder, on: machine }),
              () => ({ branch: null, origin: null }),
            );
          const git = await gits(`${machine ?? ''}\0${folder}`, now, readsGit);
          const card: BuiltCard = {
            id: agent.id,
            agents: [agent.id],
            linked: Boolean(link),
            file: link ? link.file.path : null,
            hostId: agent.hostId ?? 'local',
            folder,
            branch: git.branch,
            origin: git.origin,
            harness: agent.agent,
            harnessName: HARNESS_NAMES[agent.agent ?? ''] ?? agent.agent ?? NA,
            title: agent.title,
            status: agent.state,
            machine,
            stateSince: agent.stateSince ?? null,
            stats: session.stats,
            subAgents: session.subAgents,
          };
          // Agents share a card within their workspace folder only: omp agents of nested
          // workspace folders can link one session by title, and each workspace row draws its
          // own agent's card of it. The session path tells the harness and the machine.
          return { sessionPath: sessionPath && `${agent.path}\0${sessionPath}`, card };
        }),
      );
      // the card of each session path, the first agent's, lists every agent that shares it
      const first = new Map<string, BuiltCard>();
      for (const { sessionPath, card } of entries) {
        if (sessionPath === null) continue;
        const shared = first.get(sessionPath);
        if (shared) shared.agents.push(card.id);
        else first.set(sessionPath, card);
      }
      return collapseBySession(entries).map((entry: (typeof entries)[number]) => entry.card);
    },

    // The finished scans of the session files read since this builder was made, and the kept
    // scans of the providers no build has asked for, as they were kept, to keep for a later run,
    // and whether any changed since this was last asked. Their states are the readers' own,
    // which a later build changes: encode them at once.
    scanned() {
      const all: { changed: boolean; scans: KeptScan[] } = { changed: false, scans: kept.filter((scan) => !hooks.has(scan.provider)) };
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
