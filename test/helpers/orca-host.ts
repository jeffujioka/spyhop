// This computer's Orca host as orca/testing's mockHost plays it for the plugin's worker and
// panel: its Orca workspaces, each with the folder Orca reports under a temporary home, the
// Orca agents in each, and the focused one.
import { hostError, mockHost } from 'orca/testing';
import { workspace as folder } from './agent-cards.ts';

type State = 'working' | 'blocked' | 'waiting' | 'done';
// An Orca workspace `name` of the Orca project `project`, with one Orca agent per state given;
// `unreadable`: its `agents.list` fails, as for a workspace removed since `workspace.list`.
export type HostWorkspace = { project: string; name: string; agents: State[]; unreadable?: boolean };

export function orcaHost(home: string, { workspaces, focused }: { workspaces: HostWorkspace[]; focused?: string }) {
  const rows = workspaces.map(({ project, name, agents, unreadable }) => {
    const path = folder(home, `${project}-${name}`);
    const projectId = `repo:${project}`;
    return {
      unreadable,
      row: { id: `${projectId}::${path}`, kind: 'worktree', name, project, projectId, path, branch: name, hostId: 'local' },
      agents: agents.map((state, i) => ({
        terminalId: `${project}-${name}-${i}`,
        title: null,
        agent: 'omp',
        state,
        stateStartedAt: 0,
        sessionId: null,
      })),
    };
  });
  const focusedRow = rows.find(({ row }) => row.name === focused)?.row;
  return mockHost({
    results: {
      'workspace.list': { workspaces: rows.map(({ row }) => row), truncated: false },
      'agents.list': ({ workspaceId }: { workspaceId: string }) => {
        const found = rows.find(({ row }) => row.id === workspaceId);
        if (found?.unreadable) throw hostError('not_found', `no workspace ${workspaceId}`);
        return { agents: found?.agents ?? [] };
      },
      'workspace.readContext': focusedRow
        ? { workspaceId: focusedRow.id, branch: focusedRow.branch, displayName: focusedRow.name, terminals: [] }
        : null,
    },
  });
}
