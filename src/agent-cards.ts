// The cards of the Orca agents on this computer: one card per harness session an agent links
// to, and one per agent that links to none, whatever its state, in the card shape of the core's
// card model (src/core/card-model.js). Each card holds what Orca says of the agent (its harness,
// state and title, the folder of its workspace), the git facts of that folder and the stats of
// the harness session the agent links to. Every program runs through `run` (src/exec.ts),
// read-only; whatever cannot be read shows as n/a on the agent's card, and a build never
// rejects.

import { readGit } from './core/git.js';
import { NA, createSessions, readStats } from './core/providers/index.js';
import { collapseBySession, linkAgents } from './core/session-link.js';
import type { Run } from './exec.ts';

// An agent as Orca reports it (`agents.list` of the worker host API, `orca agent list --json`),
// with the path of its workspace folder; `id` is the one the caller names the agent by.
export type OrcaAgent = {
  id: string;
  agent: string | null;
  state: 'working' | 'blocked' | 'waiting' | 'done';
  title: string | null;
  sessionId?: string | null;
  path: string | null;
};

// The core's provider of an Orca agent kind, and the name a card gives the harness; a kind
// without a provider is named as Orca names it.
const PROVIDERS: Record<string, string> = { omp: 'omp', claude: 'claude-code', opencode: 'opencode' };
const HARNESS_NAMES: Record<string, string> = { omp: 'omp', claude: 'Claude Code', opencode: 'opencode' };

// `home`: this computer's home folder.
export function createAgentCards({ run, home }: { run: Run; home: string }) {
  const execOn = () => run;
  const readTextOn = () => async (path: string) => {
    const read = await run('cat', ['--', path]);
    return read.code === 0 ? read.stdout : null;
  };

  // The operating system, for the `stat` the session listing runs: asked once, and again
  // after a failed ask.
  let os: Promise<string> | null = null;
  function osOf() {
    if (!os) {
      os = run('uname', ['-s']).then((uname) => {
        if (uname.code !== 0) throw new Error('uname failed');
        return uname.stdout.trim();
      });
      os.catch(() => {
        os = null;
      });
    }
    return os;
  }

  // provider -> its session hook, or null: made once, and kept, since it keeps the per-file
  // state of its session reads between builds
  const hooks = new Map();
  function hookOf(provider: string) {
    if (!hooks.has(provider)) hooks.set(provider, createSessions(provider, { execOn, readTextOn }));
    return hooks.get(provider) ?? null;
  }

  // The session file each agent of one harness and folder links to (null: none), in agent
  // order (see linkAgents, src/core/session-link.js); never rejects. A hook that can `list` the
  // folder links by the agents' sessionIds and titles; one that cannot, and an agent alone in
  // its folder without a sessionId, link to the newest session file.
  async function linkAll(agents: OrcaAgent[]) {
    const [{ agent: kind, path }] = agents;
    const provider = PROVIDERS[kind ?? ''];
    const hook = provider ? hookOf(provider) : null;
    if (!hook || !path) return agents.map(() => null);
    try {
      const where = { machine: null, cwd: path, home, os: await osOf() };
      const named = agents.some((agent) => agent.sessionId);
      if (hook.list && (named || agents.length > 1)) {
        // a named session may be older than the agents' count of newest files
        return linkAgents(await hook.list({ ...where, limit: named ? Infinity : agents.length }), agents);
      }
      const file = await hook.link(where);
      return agents.map(() => file);
    } catch {
      return agents.map(() => null);
    }
  }

  return {
    // The agents' cards, in the order of `agents`, agents that link to one session sharing the
    // card of the first of them. `now`: epoch milliseconds.
    async build(agents: OrcaAgent[], now: number) {
      // harness and folder -> its agents, in agent order
      const groups = new Map<string, OrcaAgent[]>();
      for (const agent of agents) {
        const key = `${agent.agent}\0${agent.path}`;
        groups.set(key, [...(groups.get(key) ?? []), agent]);
      }
      const linked = new Map();
      for (const group of groups.values()) {
        const files = linkAll(group);
        group.forEach((agent, i) => linked.set(agent, files.then((all) => all[i])));
      }
      // session path -> its stats, read once for the agents that link to it
      const reads = new Map();

      const entries = await Promise.all(
        agents.map(async (agent) => {
          const [git, file] = await Promise.all([readGit({ exec: run }, { cwd: agent.path, on: null }), linked.get(agent)]);
          const unlinked = { ...readStats('', null, 0), harness: agent.agent ?? NA };
          const provider = PROVIDERS[agent.agent ?? ''];
          if (file && !reads.has(file.path)) {
            reads.set(
              file.path,
              hookOf(provider)
                .read(file, { machine: null, home, now })
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
            machine: null,
            stats: file ? await reads.get(file.path) : unlinked,
          };
          return { sessionPath: file?.path ?? null, card };
        }),
      );
      return collapseBySession(entries).map((entry: (typeof entries)[number]) => entry.card);
    },
  };
}
