// Orca's id of a worktree, an Orca workspace's folder: `<repoId>::<path>`, the repoId being the
// Orca project's id; a workspace of a folder inside a project, as a paired Orca server lists one,
// adds `::workspace:<id>` after the path. Split here only.

// The repoId and path of `id`, without a trailing `::workspace:<id>`; null when it holds no `::`.
export function splitWorktreeId(id: string): { repoId: string; path: string } | null {
  const at = id.indexOf('::');
  return at < 0 ? null : { repoId: id.slice(0, at), path: id.slice(at + 2).replace(/::workspace:[^:]*$/, '') };
}
