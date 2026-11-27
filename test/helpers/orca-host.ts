// This computer's Orca host as orca/testing's mockHost plays it for the plugin's worker: its Orca
// workspaces, each with the folder Orca reports under a temporary home, and the Orca agents in
// each. It grants `capabilities`, or when not given the ones the plugin's manifest declares
// (mockHost's default), `storage:own` among them, and holds the plugin's storage, `storage` at
// first (`data().storage` is what it holds now). It focuses any terminal it is asked to
// (`terminal.focus`); `callsOf('terminal.focus')` lists those asks. `holdLists` holds back its
// `workspace.list` answers, so the worker answers no fleet, until the release it returns;
// `failLists` makes them fail, as an Orca that cannot list its workspaces does, until the end it
// returns; `remove` takes a workspace off its lists.
import { hostError, mockHost, type MockHostOptions } from 'orca/testing';
import { workspace as folder } from './agent-cards.ts';

type State = 'working' | 'blocked' | 'waiting' | 'done';
// An Orca workspace `name` of the Orca project `project`, with one Orca agent per state given,
// of the kind `harness` (omp when not given);
// `unreadable`: its `agents.list` fails, as for a workspace removed since `workspace.list`;
// `hostId`: the Orca host `workspace.list` puts it on, this computer's when not given;
// `terminals`: the terminal id of each agent, null for one in a chat with no terminal,
// `<project>-<name>-<i>` when not given;
// `sessionId`: the harness session id Orca reports for each of its agents, none when not given;
// `title`: the title Orca reports for each of its agents, none when not given; `titles`: the
// title of each agent, in place of `title`;
// `stateStartedAt`: when its agents entered their states, epoch ms, 0 when not given.
export type HostWorkspace = {
  project: string;
  name: string;
  agents: State[];
  harness?: string;
  unreadable?: boolean;
  hostId?: string;
  terminals?: (string | null)[];
  sessionId?: string;
  title?: string;
  titles?: string[];
  stateStartedAt?: number;
};

export function orcaHost(home: string, { workspaces, storage, capabilities }: { workspaces: HostWorkspace[] } & Pick<MockHostOptions, 'storage' | 'capabilities'>) {
  const rows = workspaces.map(({ project, name, agents, harness = 'omp', unreadable, hostId = 'local', terminals, sessionId = null, title = null, titles, stateStartedAt = 0 }) => {
    const path = folder(home, `${project}-${name}`);
    const projectId = `repo:${project}`;
    return {
      unreadable,
      row: { id: `${projectId}::${path}`, kind: 'worktree', name, project, projectId, path, branch: name, hostId },
      agents: agents.map((state, i) => ({
        terminalId: terminals ? terminals[i] : `${project}-${name}-${i}`,
        title: titles ? titles[i] : title,
        agent: harness,
        state,
        stateStartedAt,
        sessionId,
      })),
    };
  });
  // what `workspace.list` answers wait for, and whether they fail
  let lists = Promise.resolve();
  let failing = false;
  const host = mockHost({
    storage,
    capabilities,
    results: {
      'workspace.list': async () => {
        if (failing) throw hostError('unavailable', 'Orca cannot list its workspaces');
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
  function holdLists() {
    const { promise, resolve } = Promise.withResolvers<void>();
    lists = promise;
    return resolve;
  }
  function failLists() {
    failing = true;
    return () => {
      failing = false;
    };
  }
  // Orca no longer lists the workspace `name`, nor its agents.
  function remove(name: string) {
    rows.splice(rows.findIndex((found) => found.row.name === name), 1);
  }
  return Object.assign(host, { holdLists, failLists, remove });
}
