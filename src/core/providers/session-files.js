// Copied from herdr-session-stats (src/providers/session-files.js).
//
// Finding a harness's session files and sub-agent transcripts, keeping the readers of them and
// what their heads told: shared by the providers' `createSessions` hooks. Runtime-neutral: it
// takes the plugin's runner bound to an Orca host and runs only `find` with `stat`, `head`, and
// `tail` and `dd` through the session reader (src/core/refresh.js).

import { createLimit } from '../limit.js';
import { createSessionReader, utf8Length } from '../refresh.js';
import { linkSession, newestFirst } from '../session-link.js';

// Most `head` reads (the folder a session records, and what else its head tells) run at once
// by one hook.
const HEAD_READS = 4;

// Most sub-agent transcripts of one session that a refresh reads when they are new or changed
// since their last read, the newest first: a session can have 90 of them, each up to 18.5 MB,
// over ssh. An unchanged one costs no read, so the others are read by the next refreshes.
export const SUBAGENT_READS_PER_REFRESH = 16;

// How many folders deep below a session's sub-agent folder the listing looks, for sub-agents
// of sub-agents: each is one level below the one that started it.
export const SUBAGENT_DEPTH = 8;

// A folder a session records as its own, or null for a value that names none. A path that is
// not absolute names none: git would be run in it relative to the plugin's own process folder.
export const absoluteFolder = (value) => (typeof value === 'string' && value.startsWith('/') ? value : null);

// Whether `file` is as it was when the head `hit` was read from it, by its time and size.
export const unchangedSince = (hit, file) => hit.mtimeMs === file.mtimeMs && hit.size === file.size;

// The main session file of the file `path` under `sessionsDir`, where omp and Claude Code keep a
// session as `<sessionsDir>/<folder>/<session>.jsonl` and its sub-agents' transcripts below
// `<sessionsDir>/<folder>/<session>/`: `path` itself for a session file, else its session's.
export function mainSessionOf(path, sessionsDir) {
  const [folder, session, ...below] = path.slice(sessionsDir.length + 1).split('/');
  return below.length === 0 ? path : `${sessionsDir}/${folder}/${session}.jsonl`;
}

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
// reader together (see `createSessionReader`), each scan with its `machine`, and the kept scans
// of the hosts no reader was made for, as they were kept.
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
      const all = { changed: false, scans: kept.filter((scan) => !readers.has(scan.machine)) };
      for (const [machine, reader] of readers) {
        const { changed, scans } = reader.scanned();
        all.changed ||= changed;
        for (const scan of scans) all.scans.push({ machine, ...scan });
      }
      return all;
    },
  };
}

// The reads of one hook's sub-agent transcripts through its `readers` (see `sessionReaders`), so
// that their scans are kept and stored as session files' are. `inputs(machine, transcripts)`
// gives, for each of the listed `transcripts` (`{ path, mtimeMs, size }` each) in their order,
// a promise of the `input` of the provider's `readStats` for it, or of null when it is not read:
// one unchanged since its last read gives that read and runs no program; of the new or changed
// ones the SUBAGENT_READS_PER_REFRESH newest are read, and the others are left to later calls.
// A read that gives no totals (a failed program) gives null, and the transcript is read again
// when due.
export function subAgentReads(readers) {
  // machine and path -> { mtimeMs, size } of the transcript at that path when its last read
  // gave its totals: one unchanged since costs no read, and is not one of the
  // SUBAGENT_READS_PER_REFRESH of a call
  const lastReads = new Map();

  async function read(machine, transcript) {
    const key = `${machine ?? ''}\0${transcript.path}`;
    const input = await readers.on(machine).read(transcript);
    if (input.sources.wholeFile || input.state) {
      lastReads.set(key, { mtimeMs: transcript.mtimeMs, size: transcript.size });
      return input;
    }
    lastReads.delete(key);
    return null;
  }

  return {
    inputs(machine, transcripts) {
      const due = transcripts.filter((transcript) => {
        const hit = lastReads.get(`${machine ?? ''}\0${transcript.path}`);
        return !(hit && unchangedSince(hit, transcript));
      });
      const deferred = new Set(newestFirst(due).slice(SUBAGENT_READS_PER_REFRESH));
      return transcripts.map((transcript) => (deferred.has(transcript) ? Promise.resolve(null) : read(machine, transcript)));
    },
  };
}

// What `read(machine, path)` gives of each file, read at its first call and kept for good, for
// what a harness writes once: a read that rejects keeps nothing, so the next call reads the
// file again. A call's promise gives null for a read that rejected.
export function readOnce(read) {
  const told = new Map();
  return (machine, path) => {
    const key = `${machine ?? ''}\0${path}`;
    if (!told.has(key)) {
      const reading = read(machine, path);
      reading.catch(() => told.delete(key));
      told.set(key, reading);
    }
    return told.get(key).catch(() => null);
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
// `strict`: for a caller to whom a failed listing is not an empty one. Then only a `dir` that
// does not exist is none, which `find` tells by its non-zero exit with nothing listed and the
// words of ENOENT about `dir` on stderr (BSD `find: <dir>: No such file or directory`, GNU with
// `<dir>` quoted); any other failure rejects.
export async function listFolder(exec, { dir, os, depth = 1, names = ['*.jsonl'], path, strict = false }) {
  const stat = STAT_COMMANDS[os];
  if (!stat) {
    if (strict) throw new Error(`no stat known on ${os}`);
    return [];
  }
  const anyName = names.flatMap((name) => ['-o', '-name', name]).slice(1);
  const tests = path ? ['-path', path] : names.length > 1 ? ['(', ...anyName, ')'] : anyName;
  const listed = await exec('find', ['-H', dir, '-maxdepth', String(depth), ...tests, '-exec', ...stat, '{}', '+']);
  if (listed.code === 0) return parseSessionFiles(listed.stdout);
  const stderr = listed.stderr ?? '';
  const missing = listed.stdout === '' && stderr.includes(dir) && stderr.includes('No such file or directory');
  if (strict && !missing) throw new Error(`find failed on ${dir}`);
  return [];
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
