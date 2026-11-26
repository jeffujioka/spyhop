// Copied from herdr-session-stats (src/providers/claude-sources.js).
//
// The Claude Code side of a card's I/O: where Claude Code keeps its sessions, the text of one
// and the folder it started in (src/core/providers/claude.js reads only values handed in). It
// is the Claude Code provider's `createSessions` hook (see the stats-shape header of
// src/core/providers/index.js). Runtime-neutral: it takes the plugin's runner bound to an Orca
// host, and runs only read-only programs there: `find` with `stat`, `head`, and `tail` and `dd`
// (through the session reader).

import { claudeProvider } from './claude.js';
import { parseEntries } from './jsonl.js';
import { absoluteFolder, findNamedFiles, findSessionFile, sessionHeads, sessionReaders } from './session-files.js';

// Name of Claude Code's session folder for a working folder (herdr-session-stats
// docs/claude-session-format.md): the path with every character that is not a letter or a
// digit turned into `-`. Claude Code shortens a very long name with a hash, which spyhop does
// not reproduce: an agent of such a folder without a session id has no linked session, so its
// card reads n/a.
export function sessionDirSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// The folder Claude Code keeps every working folder's session folder in.
const sessionsRoot = (home) => `${home}/.claude/projects`;

// How much of the start of a session file is read for the folder the session started in.
// Claude Code writes `cwd` on its message entries, not on the entries a file can start with (a
// mode, a summary, file-history snapshots), and the first message holds the whole first prompt:
// the first `cwd` ended within 18 KiB in the sessions looked at, so 64 KiB leaves room, and a
// read by bytes stays small whatever the length of a line (a pasted file, an image).
export const START_BYTES = 64 * 1024;

// The folder a session started in, from `text`, which starts with the start of its file: the
// `cwd` of the first entry that holds one (see `absoluteFolder`), or null. Not the latest
// entry's: a session that moved on to another folder is still the session of the first.
function startFolder(text) {
  for (const line of text.split('\n')) {
    if (!line.includes('"cwd"')) continue;
    const folder = absoluteFolder(parseEntries(line)[0]?.cwd);
    if (folder) return folder;
  }
  return null;
}

// `execOn(machine)`: the plugin's runner bound to an Orca host (null: this computer). `kept`:
// the scans of Claude Code session files an earlier run kept (see `sessionReaders`).
export function createClaudeSessions({ execOn, kept }) {
  // each machine's reader, which keeps that machine's per-file totals
  const readers = sessionReaders(execOn, claudeProvider.fold, kept);
  // What the start of each session file told (see `sessionHeads`): the folder it started in.
  const heads = sessionHeads(execOn, { head: ['-c', String(START_BYTES)], tells: (text) => ({ cwd: startFolder(text) }) });

  return {
    // The session file the agent's folder links to (`{ path, mtimeMs, size }`) that is not in
    // `except`, or null. Only the files directly in the folder are sessions; the folders beside
    // them hold sub-agent data.
    link({ machine, cwd, home, os, except }) {
      return findSessionFile(execOn(machine), { dir: `${sessionsRoot(home)}/${sessionDirSlug(cwd)}`, os, except });
    },

    // The session file each of `sessionIds` names on the host, or null: Claude Code names a
    // session file `<id>.jsonl`, in the session folder of the folder the session started in,
    // which can be another than the agent's workspace folder (a sub-folder of it, for one).
    // Only the files directly in a session folder are sessions: the listing does not go into
    // the folders beside them, which hold sub-agent data.
    named({ machine, home, os }, sessionIds) {
      const root = sessionsRoot(home);
      const where = { dir: root, os, depth: 2, pattern: (id) => `${id}.jsonl` };
      const inSessionFolder = (path) => path.lastIndexOf('/') > root.length;
      return findNamedFiles(execOn(machine), where, sessionIds, (path, id) => path.endsWith(`/${id}.jsonl`) && inSessionFolder(path));
    },

    // The `input` of `readStats('claude-code', input, now)` for a linked file: its tail window,
    // and the totals over the whole file when that is larger. A file that is whole in the text
    // read also tells the folder it started in, for `folder`.
    async read(file, { machine }) {
      const input = await readers.on(machine).read(file);
      if (input.sources.wholeFile) heads.learn(machine, file, input.text);
      return input;
    },

    // The folder the session of a linked file started in, or null. `read` of a file that is
    // whole in its window answers; the start of a larger file is outside that window and is
    // read once, by one `head`, and again at the next call when that read failed.
    folder(file, { machine }) {
      return heads.folder(machine, file);
    },

    // The finished scans of the files read, to keep for a later run (see `sessionReaders`).
    scanned: readers.scanned,
  };
}
