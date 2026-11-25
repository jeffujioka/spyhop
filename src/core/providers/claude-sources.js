// Copied from herdr-session-stats (src/providers/claude-sources.js).
//
// The Claude Code side of a card's I/O: where Claude Code keeps a folder's sessions, and the
// text of one (src/core/providers/claude.js reads only values handed in). It is the Claude
// Code provider's `createSessions` hook (see the stats-shape header of
// src/core/providers/index.js). Runtime-neutral: it takes the plugin's runner bound to an Orca
// host, and runs only read-only programs there: `find` with `stat`, and `tail` and `dd`
// (through the session reader).

import { claudeProvider } from './claude.js';
import { findSessionFile, sessionReaders } from './session-files.js';

// Name of Claude Code's session folder for a working folder (docs/claude-session-format.md):
// the path with every character that is not a letter or a digit turned into `-`. Claude Code
// shortens a very long name with a hash, which spyhop does not reproduce: such a folder has
// no linked session, so its card reads n/a.
export function sessionDirSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// `execOn(machine)`: the plugin's runner bound to an Orca host (null: this computer).
export function createClaudeSessions({ execOn }) {
  // machine -> the reader that keeps that machine's per-file totals
  const readerOn = sessionReaders(execOn, claudeProvider.fold);

  return {
    // The session file the agent's folder links to (`{ path, mtimeMs, size }`), or null. Only
    // the files directly in the folder are sessions; the folders beside them hold sub-agent data.
    link({ machine, cwd, home, os }) {
      const dir = `${home}/.claude/projects/${sessionDirSlug(cwd)}`;
      return findSessionFile(execOn(machine), { dir, os });
    },

    // The `input` of `readStats('claude-code', input, now)` for a linked file: its tail window,
    // and the totals over the whole file when that is larger.
    read(file, { machine }) {
      return readerOn(machine).read(file);
    },
  };
}
