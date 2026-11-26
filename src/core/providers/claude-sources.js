// Copied from herdr-session-stats (src/providers/claude-sources.js).
//
// The Claude Code side of a card's I/O: where Claude Code keeps a folder's sessions, and the
// text of one (src/core/providers/claude.js reads only values handed in). It is the Claude
// Code provider's `createSessions` hook (see the stats-shape header of
// src/core/providers/index.js). Runtime-neutral: it takes the plugin's runner bound to an Orca
// host, and runs only read-only programs there: `find` with `stat`, and `tail` and `dd`
// (through the session reader).

import { claudeProvider } from './claude.js';
import { findNamedFiles, findSessionFile, sessionReaders } from './session-files.js';

// Name of Claude Code's session folder for a working folder (herdr-session-stats
// docs/claude-session-format.md): the path with every character that is not a letter or a
// digit turned into `-`. Claude Code shortens a very long name with a hash, which spyhop does
// not reproduce: such a folder has no linked session, so its card reads n/a.
export function sessionDirSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// The folder Claude Code keeps the sessions of a working folder in.
const sessionDir = (cwd, home) => `${home}/.claude/projects/${sessionDirSlug(cwd)}`;

// `execOn(machine)`: the plugin's runner bound to an Orca host (null: this computer). `kept`:
// the scans of Claude Code session files an earlier run kept (see `sessionReaders`).
export function createClaudeSessions({ execOn, kept }) {
  // each machine's reader, which keeps that machine's per-file totals
  const readers = sessionReaders(execOn, claudeProvider.fold, kept);

  return {
    // The session file the agent's folder links to (`{ path, mtimeMs, size }`) that is not in
    // `except`, or null. Only the files directly in the folder are sessions; the folders beside
    // them hold sub-agent data.
    link({ machine, cwd, home, os, except }) {
      return findSessionFile(execOn(machine), { dir: sessionDir(cwd, home), os, except });
    },

    // The session file each of `sessionIds` names in the folder, or null: Claude Code names a
    // session file `<id>.jsonl`.
    named({ machine, cwd, home, os }, sessionIds) {
      const dir = sessionDir(cwd, home);
      return findNamedFiles(execOn(machine), { dir, os }, sessionIds, (path, id) => path === `${dir}/${id}.jsonl`);
    },

    // The `input` of `readStats('claude-code', input, now)` for a linked file: its tail window,
    // and the totals over the whole file when that is larger.
    read(file, { machine }) {
      return readers.on(machine).read(file);
    },

    // The finished scans of the files read, to keep for a later run (see `sessionReaders`).
    scanned: readers.scanned,
  };
}
