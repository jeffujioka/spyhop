// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host: no Orca agent, and two Orca workspaces of one project with the second focused, each
// with an agent in a terminal, so each card draws its Focus pane button.
import { defineCheck } from 'orca/testing';

const workspace = (name: string) => ({
  id: `repo:api::/work/api-${name}`,
  kind: 'worktree',
  name,
  project: 'api',
  projectId: 'repo:api',
  path: `/work/api-${name}`,
  branch: name,
  hostId: 'local',
});

export default defineCheck({
  empty: { results: { 'workspace.list': { workspaces: [], truncated: false }, 'workspace.readContext': null } },
  agents: {
    results: {
      'workspace.list': { workspaces: [workspace('main'), workspace('fix-login')], truncated: false },
      'agents.list': ({ workspaceId }: { workspaceId: string }) => ({
        agents: [
          {
            terminalId: `${workspaceId}-t1`,
            title: null,
            agent: 'omp',
            state: workspaceId.endsWith('main') ? 'working' : 'waiting',
            stateStartedAt: 0,
          },
        ],
      }),
      'workspace.readContext': { workspaceId: 'repo:api::/work/api-fix-login', branch: 'fix-login', displayName: 'fix-login', terminals: [] },
    },
  },
});
