// Copied from herdr-session-stats (src/providers/session-files.js).
//
// Finding a harness's session files, keeping the readers of them and what their heads told:
// shared by the providers' `createSessions` hooks. Runtime-neutral: it takes the plugin's runner
// bound to an Orca host and runs only `find` with `stat`, `head`, and `tail` and `dd` through
// the session reader (src/core/refresh.js).

import { createLimit } from '../limit.js';
import { createSessionReader, utf8Length } from '../refresh.js';
import { linkSession, newestFirst } from '../session-link.js';

// Most `head` reads (the folder a session records, and what else its head tells) run at once
// by one hook.
const HEAD_READS = 4;

// A folder a session records as its own, or null for a value that names none. A path that is
// not absolute names none: git would be run in it relative to the plugin's own process folder.
export const absoluteFolder = (value) => (typeof value === 'string' && value.startsWith('/') ? value : null);

// Whether `file` is as it was when the head `hit` was read from it, by its time and size.
export const unchangedSince = (hit, file) => hit.mtimeMs === file.mtimeMs && hit.size === file.size;

// What the heads of one hook's session files told, kept between calls. `head`: the arguments of
// `head` that bound the read (`['-n', '2']`). `tells(text)`: what a text that starts with the
// head of a file tells, an object with `cwd`, the folder the session records as its own or
// null, and whatever else the hook reads there (omp: the title).
//
// machine and path -> { mtimeMs, size, cwd, ... }: what `tells` gave, with the time and size of
// the file it was read from. One entry per file, replaced when the file is read again.
// - What it told besides the folder holds while the file is unchanged, so a refresh of quiet
//   files runs no program.
// - A folder found is kept for good, since a harness writes where a session started once, when
//   it starts.
// - No folder in a read that stopped before the end of its file (`folderless`) is kept for
//   good too: the read held all the head looks at, and a harness only appends after it (omp
//   rewrites its title line in place, which is asked again through `of`, not the lines that
//   record the folder). No folder in a read that held the whole file is asked again when the
//   file changed, since the head may not have been written out yet.
// - A head that could not be read (a failed program, as when ssh fails) leaves no entry and
//   replaces none: nothing was learned, so the next call reads the file again.
export function sessionHeads(execOn, { head, tells }) {
  const heads = new Map();
  const reads = createLimit(HEAD_READS);
  const keyOf = (machine, file) => `${machine ?? ''}\0${file.path}`;
  const keep = (machine, file, text, hit) => {
    const told = { mtimeMs: file.mtimeMs, size: file.size, ...tells(text) };
    if (hit?.cwd) told.cwd = hit.cwd;
    if (told.cwd === null) told.folderless = utf8Length(text) < file.size;
    heads.set(keyOf(machine, file), told);
    return told;
  };
  // The entry of `file` when it tells the file's folder as it is now: a folder found, none for
  // good, or none in a file unchanged since; else null.
  function known(machine, file) {
    const hit = heads.get(keyOf(machine, file));
    return hit && (hit.cwd !== null || hit.folderless || unchangedSince(hit, file)) ? hit : null;
  }
  // The text of the head of a file, or null when it could not be read (a failed program).
  async function readHead(machine, path) {
    try {
      const { code, stdout } = await execOn(machine)('head', [...head, '--', path]);
      return code === 0 ? stdout : null;
    } catch {
      return null;
    }
  }

  const self = {
    // The entry last kept of `file`, whatever the file is now, or null.
    last(machine, file) {
      return heads.get(keyOf(machine, file)) ?? null;
    },

    // The entry of `file`, from one `head` when the file changed since it was read, or never
    // was. When that read fails it is the earlier entry, or null without one.
    async of(machine, file) {
      const hit = self.last(machine, file);
      if (hit && unchangedSince(hit, file)) return hit;
      const text = await reads(() => readHead(machine, file.path));
      return text === null ? hit : keep(machine, file, text, hit);
    },

    // Takes what `text` tells, the text of a session reader's read of `file` that holds the
    // whole file, unless the file's folder is known: no `head` is run for such a file.
    learn(machine, file, text) {
      if (!known(machine, file)) keep(machine, file, text, null);
    },

    // The folder the session of `file` records, or null: from what is known of the file, else
    // from one `head`, and again at the next call when that read failed.
    async folder(machine, file) {
      return (known(machine, file) ?? (await self.of(machine, file)))?.cwd ?? null;
    },
  };
  return self;
}

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
// is read. A harness keeps each working folder's sessions in a folder of its own under `dir`,
// so `depth` is 2, and `pattern(sessionId)` is the `find -name` pattern of the file an id can
// name: the listing then prints those files only, whatever folder holds them, so what it
// prints does not grow with the sessions of the host, though `find` still walks every session
// folder. The newest file wins when an id names several.
export async function findNamedFiles(exec, { dir, os, depth, pattern }, sessionIds, names) {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (ids.length === 0) return sessionIds.map(() => null);
  const files = newestFirst(await listFolder(exec, { dir, os, depth, names: ids.map(pattern) }));
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
