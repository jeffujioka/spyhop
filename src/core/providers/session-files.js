// Copied from herdr-session-stats (src/providers/session-files.js).
//
// Finding a harness's session files and keeping the readers of them: shared by the providers'
// `createSessions` hooks. Runtime-neutral: it takes the plugin's runner bound to an Orca host
// and runs only `find` with `stat`, and `tail` and `dd` through the session reader
// (src/core/refresh.js).

import { createSessionReader } from '../refresh.js';
import { linkSession, newestFirst } from '../session-link.js';

// The readers of one hook. `on(machine)`: the reader that keeps that host's per-file totals,
// made on first use. `execOn(machine)` is the plugin's runner bound to a host, `fold` the
// provider's. `kept`: the scans an earlier run kept for this provider (`{ machine, path, pos,
// state }` each), each host's given to its reader; `scanned()` is `{ changed, scans }` of every
// reader together (see `createSessionReader`), each scan with its `machine`.
export function sessionReaders(execOn, fold, kept = []) {
  const readers = new Map();
  return {
    on(machine) {
      if (!readers.has(machine)) {
        readers.set(machine, createSessionReader({ exec: execOn(machine), fold, kept: kept.filter((scan) => scan.machine === machine) }));
      }
      return readers.get(machine);
    },

    scanned() {
      const all = { changed: false, scans: [] };
      for (const [machine, reader] of readers) {
        const { changed, scans } = reader.scanned();
        all.changed ||= changed;
        for (const scan of scans) all.scans.push({ machine, ...scan });
      }
      return all;
    },
  };
}

// Lines of `stat` as `<mtime seconds> <size> <path>`; anything else is skipped.
export function parseSessionFiles(stdout) {
  const files = [];
  for (const line of stdout.split('\n')) {
    const match = /^(\d+) (\d+) (.+)$/.exec(line);
    if (match) files.push({ path: match[3], mtimeMs: Number(match[1]) * 1000, size: Number(match[2]) });
  }
  return files;
}

// `stat` prints its format differently on BSD (macOS) and GNU (Linux); `uname -s` says which.
// The program is named with the format: on macOS a GNU `stat` first in PATH (coreutils from
// Homebrew) would read `-f` as a filesystem report, so the system's own is run by its path.
const STAT_COMMANDS = {
  Darwin: ['/usr/bin/stat', '-f', '%m %z %N'],
  Linux: ['stat', '-c', '%Y %s %n'],
};

// The files in `dir` and up to `depth` folders deep (1: directly in it) that the `names` name
// (`find -name` patterns), or whose whole path is `path` (a `find -path` pattern) when given, as
// `{ path, mtimeMs, size }`; none when the folder cannot be listed or the system is one whose
// `stat` is unknown. `-H` has `find` go into a `dir` that is a symbolic link (a home whose
// dot-folders a dotfile manager links), which it would only name otherwise.
async function listFolder(exec, { dir, os, depth = 1, names = ['*.jsonl'], path }) {
  const stat = STAT_COMMANDS[os];
  if (!stat) return [];
  const anyName = names.flatMap((name) => ['-o', '-name', name]).slice(1);
  const tests = path ? ['-path', path] : names.length > 1 ? ['(', ...anyName, ')'] : anyName;
  const listed = await exec('find', ['-H', dir, '-maxdepth', String(depth), ...tests, '-exec', ...stat, '{}', '+']);
  return listed.code === 0 ? parseSessionFiles(listed.stdout) : [];
}

// The session file in `dir` (only the `.jsonl` files directly in it) whose path is not in
// `except` that an agent links to (see session-link.js), as `{ path, mtimeMs, size }`, or null.
export async function findSessionFile(exec, { dir, os, except = [] }) {
  const files = (await listFolder(exec, { dir, os })).filter((file) => !except.includes(file.path));
  const path = linkSession(files);
  return files.find((file) => file.path === path) ?? null;
}

// The session file each of `sessionIds` names in `dir` (null for a null id and for an id that
// names no file), by the harness's own rule `names(path, sessionId)`: one listing, and no file
// is read. A harness that keeps each working folder's sessions in a folder of its own under
// `dir` gives `depth` 2 and `pattern(sessionId)`, the `find -name` pattern of the file an id
// can name: the listing then prints those files only, whatever folder holds them, so its cost
// does not grow with the sessions of the host. The newest file wins when an id names several.
export async function findNamedFiles(exec, { dir, os, depth, pattern }, sessionIds, names) {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (ids.length === 0) return sessionIds.map(() => null);
  const files = newestFirst(await listFolder(exec, { dir, os, depth, names: pattern && ids.map(pattern) }));
  return sessionIds.map((id) => (id ? files.find((file) => names(file.path, id)) : null) ?? null);
}

// The `.jsonl` files directly in the folders of `dir` whose name starts with `prefix`, newest
// first, as `{ path, mtimeMs, size }`: one listing, whatever the number of those folders, which
// prints the files of no other folder. `dir` and `prefix` are taken as they are written: a `*`,
// `?`, `[` or `\` in them is no pattern.
export async function listFilesOfFolders(exec, { dir, os, prefix }) {
  const written = `${dir}/${prefix}`.replace(/[\\*?[\]]/g, '\\$&');
  return newestFirst(await listFolder(exec, { dir, os, depth: 2, path: `${written}*/*.jsonl` }));
}
