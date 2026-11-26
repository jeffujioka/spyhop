// An omp Orca agent of a paired Orca server, as `orca agent list --environment` lists one: in
// the server's workspace `name` of its project `spyhop`, whose folder is `folder`, in the pane
// `paneKey`; `fields` gives it another state or a title.
export const serverAgent = (folder: string, name: string, paneKey: string, fields: { state?: string; title?: string } = {}) => ({
  orcaSessionId: `session-${name}`,
  kind: 'terminal',
  agent: 'omp',
  state: 'working',
  worktreeId: `repo-spyhop::${folder}`,
  workspace: name,
  repo: 'spyhop',
  hostId: 'local',
  paneKey,
  title: null,
  updatedAt: 0,
  ...fields,
});
