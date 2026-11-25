// Copied from herdr-session-stats (src/git.js).
//
// Read-only git facts for a card: the branch and the origin remote URL of an Orca agent's
// workspace folder. Runtime-neutral: the plugin passes in its runner,
// `exec(command, args, options)` (`{ code, stdout, stderr }`, src/exec.ts). Only
// `git branch --show-current` and `git remote get-url origin` are run, in the workspace folder
// through `cwd`, so no path is an argument; neither writes, and no shell string or
// redirection is used.

// A folder's branch and origin are asked again after this long (copied from herdr-session-stats,
// src/cards.js).
export const GIT_TTL_MS = 30 * 1000;

// The URL of a remote without the credentials of an http(s) or ftp(s) URL: the userinfo
// (`user:token@`, `token@`) is replaced by `***`, so a secret never reaches a card or a log.
// The userinfo ends at the last `@` of the authority. A bare user name of an scp-style or
// ssh:// remote (`git@host:org/repo.git`) is not a secret and stays, as does a URL without one.
const maskCredentials = (url) => url.replace(/^((?:https?|ftps?):\/\/)[^/?#]*@/i, '$1***@');

// One git fact: the first line git prints, or null when git fails (not a repository, no
// origin remote), prints nothing (a detached HEAD has no branch), or cannot be run at all
// (no such folder, the Orca host is unreachable). A card shows no line for a null.
async function ask(exec, args, options) {
  try {
    const { code, stdout } = await exec('git', args, options);
    if (code !== 0) return null;
    const line = stdout.split('\n', 1)[0].trim();
    return line === '' ? null : line;
  } catch {
    return null;
  }
}

// `{ cwd, on }`: an Orca workspace folder and the Orca host it is on (null or absent for this
// computer, where `on` is left out of the call). The commands run on that host, not here.
// A workspace without a folder is not asked: git would answer for the plugin's own folder.
// Resolves to `{ branch, origin }`, each a string or null.
export async function readGit({ exec }, { cwd, on }) {
  if (!cwd) return { branch: null, origin: null };
  const options = on ? { cwd, on } : { cwd };
  const [branch, origin] = await Promise.all([
    ask(exec, ['branch', '--show-current'], options),
    ask(exec, ['remote', 'get-url', 'origin'], options),
  ]);
  return { branch, origin: origin === null ? null : maskCredentials(origin) };
}
