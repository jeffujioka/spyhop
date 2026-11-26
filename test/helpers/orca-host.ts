// This computer's Orca host as orca/testing's mockHost plays it for the plugin's worker and
// panel: its Orca workspaces, each with the folder Orca reports under a temporary home, the
// Orca agents in each, and the focused one, which `focus` moves. It focuses any terminal it is
// asked to (`terminal.focus`); `callsOf('terminal.focus')` lists those asks. `holdLists` holds
// back its `workspace.list` answers, so the worker answers no tree, until the release it returns;
// `remove` takes a workspace off its lists. `relayPosts` hands a mounted panel what the worker
// posted, which Orca does and the test kit does not.
import { setImmediate } from 'node:timers/promises';
import { hostError, mockHost, type TestPanel, type TestWorker } from 'orca/testing';
import { workspace as folder } from './agent-cards.ts';

type State = 'working' | 'blocked' | 'waiting' | 'done';
// An Orca workspace `name` of the Orca project `project`, with one Orca agent per state given;
// `unreadable`: its `agents.list` fails, as for a workspace removed since `workspace.list`;
// `hostId`: the Orca host `workspace.list` puts it on, this computer's when not given;
// `terminals`: the terminal id of each agent, null for one in a chat with no terminal,
// `<project>-<name>-<i>` when not given.
export type HostWorkspace = { project: string; name: string; agents: State[]; unreadable?: boolean; hostId?: string; terminals?: (string | null)[] };

export function orcaHost(home: string, { workspaces, focused }: { workspaces: HostWorkspace[]; focused?: string }) {
  const rows = workspaces.map(({ project, name, agents, unreadable, hostId = 'local', terminals }) => {
    const path = folder(home, `${project}-${name}`);
    const projectId = `repo:${project}`;
    return {
      unreadable,
      row: { id: `${projectId}::${path}`, kind: 'worktree', name, project, projectId, path, branch: name, hostId },
      agents: agents.map((state, i) => ({
        terminalId: terminals ? terminals[i] : `${project}-${name}-${i}`,
        title: null,
        agent: 'omp',
        state,
        stateStartedAt: 0,
        sessionId: null,
      })),
    };
  });
  // what `workspace.list` answers wait for
  let lists = Promise.resolve();
  const host = mockHost({
    results: {
      'workspace.list': async () => {
        await lists;
        return { workspaces: rows.map(({ row }) => row), truncated: false };
      },
      'agents.list': ({ workspaceId }: { workspaceId: string }) => {
        const found = rows.find(({ row }) => row.id === workspaceId);
        if (found?.unreadable) throw hostError('not_found', `no workspace ${workspaceId}`);
        return { agents: found?.agents ?? [] };
      },
      'terminal.focus': { focused: true },
    },
  });
  // Focuses the workspace `name`, none when no workspace has it, and returns what
  // `workspace.readContext` now answers, as `workspace.changed` reports it.
  function focus(name?: string) {
    const row = rows.find((found) => found.row.name === name)?.row;
    const context = row ? { workspaceId: row.id, branch: row.branch, displayName: row.name, terminals: [] } : null;
    host.respond('workspace.readContext', context);
    return context;
  }
  focus(focused);
  function holdLists() {
    const { promise, resolve } = Promise.withResolvers<void>();
    lists = promise;
    return resolve;
  }
  // Orca no longer lists the workspace `name`, nor its agents.
  function remove(name: string) {
    rows.splice(rows.findIndex((found) => found.row.name === name), 1);
  }
  return Object.assign(host, { focus, holdLists, remove });
}

// Hands `panel` each of the worker's `posts` (`worker.posts`), in order, once there are `count`
// of them, and returns once the panel has drawn what it made of them; rejects when the worker
// has not posted that many within 5 s. It waits for no answer of the worker, as the panel's own
// `post` does, so it also returns while a request of the panel is unanswered.
export async function relayPosts(posts: TestWorker['posts'], panel: TestPanel, count: number) {
  const end = Date.now() + 5000;
  while (posts.length < count) {
    if (Date.now() > end) throw new Error(`the worker posted ${posts.length} times, not ${count}`);
    await setImmediate();
  }
  for (const { event, payload } of posts) void panel.post(event as never, payload as never);
  // the panel's draw runs in the task the first `post` queued, before this one
  await setImmediate();
}
