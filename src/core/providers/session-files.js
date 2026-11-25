// Copied from herdr-session-stats (src/providers/session-files.js).
//
// Finding a harness's session files and keeping the readers of them: shared by the providers'
// `createSessions` hooks. Runtime-neutral: it takes the plugin's runner bound to an Orca host
// and runs only `find` with `stat`, and `tail` and `dd` through the session reader
// (src/core/refresh.js).

import { createSessionReader } from '../refresh.js';
import { linkSession, newestFirst } from '../session-link.js';

// `readerOn(machine)` of one hook: the reader that keeps that host's per-file totals, made on
// first use. `execOn(machine)` is the plugin's runner bound to a host, `fold` the provider's.
export function sessionReaders(execOn, fold) {
  const readers = new Map();
  return (machine) => {
    if (!readers.has(machine)) readers.set(machine, createSessionReader({ exec: execOn(machine), fold }));
    return readers.get(machine);
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

// The `.jsonl` files directly in `dir`, as `{ path, mtimeMs, size }`; none when the folder
// cannot be listed or the system is one whose `stat` is unknown.
async function listFolder(exec, { dir, os }) {
  const stat = STAT_COMMANDS[os];
  if (!stat) return [];
  const listed = await exec('find', [dir, '-maxdepth', '1', '-name', '*.jsonl', '-exec', ...stat, '{}', '+']);
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
// names no file), by the harness's own rule `names(path, sessionId)`: one listing of the folder,
// and no file is read.
export async function findNamedFiles(exec, { dir, os }, sessionIds, names) {
  const files = await listFolder(exec, { dir, os });
  return sessionIds.map((id) => (id ? files.find((file) => names(file.path, id)) : null) ?? null);
}

// The `limit` newest session files in `dir` whose path is not in `except`, newest first, as
// `{ path, mtimeMs, size }`: the candidates for the agents that share the folder (see
// `shareSessions` in session-link.js). None when `except` holds every file.
export async function listSessionFiles(exec, { dir, os, limit, except = [] }) {
  const files = newestFirst(await listFolder(exec, { dir, os }));
  return files.filter((file) => !except.includes(file.path)).slice(0, limit);
}
