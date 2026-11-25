// Orca's id of a worktree, an Orca workspace's folder: `<repoId>::<path>`, the repoId being the
// Orca project's id. Built and split here only.

export const worktreeId = (repoId: string, path: string) => `${repoId}::${path}`;

// The repoId and path of `id`; null when it holds no `::`.
export function splitWorktreeId(id: string): { repoId: string; path: string } | null {
  const at = id.indexOf('::');
  return at < 0 ? null : { repoId: id.slice(0, at), path: id.slice(at + 2) };
}
