// Copied from herdr-session-stats (src/providers/opencode-sources.js).
//
// The opencode side of a card's I/O: where opencode keeps a folder's sessions and the rows its
// figures need (src/core/providers/opencode.js reads only values handed in). It is the opencode
// provider's `createSessions` hook (see the stats-shape header of src/core/providers/index.js).
// Runtime-neutral: it takes the plugin's runner bound to an Orca host and runs one read-only
// program there, `sqlite3 -readonly -json <database> <SELECT>`; opencode's own CLI is not run
// and nothing is written. The database and its layout: herdr-session-stats
// docs/opencode-session-format.md.

import { absoluteFolder } from './session-files.js';

// opencode's database under the host's home folder. opencode follows `XDG_DATA_HOME`; the
// plugin reads the default place only, and an agent whose opencode keeps it elsewhere reads n/a.
const databaseOf = (home) => `${home}/.local/share/opencode/opencode.db`;

// A string as an SQL literal. Folders and the agents' session ids come from Orca, the other
// session ids from the database, so no text is put into a query unquoted.
const literal = (text) => `'${String(text).replace(/'/g, "''")}'`;

// The newest session of a folder that is not archived, is not a sub-agent's and whose id is
// not in `except`: opencode updates `time_updated` of a session when a message of it changes.
function sessionQuery(cwd, except = []) {
  const folder = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
  const others = except.length ? `AND id NOT IN (${except.map(literal).join(', ')}) ` : '';
  return (
    'SELECT id, time_updated AS mtimeMs, directory FROM session ' +
    `WHERE directory = ${literal(folder)} AND parent_id IS NULL AND time_archived IS NULL ${others}` +
    'ORDER BY time_updated DESC LIMIT 1'
  );
}

// The sessions whose ids are `ids`, whatever their folder.
function namedQuery(ids) {
  return `SELECT id, time_updated AS mtimeMs, directory FROM session WHERE id IN (${ids.map(literal).join(', ')})`;
}

// A session row as the session `{ path, mtimeMs, size, folder }` it links: `path` is the
// session id, which names it on its host, `size` is 0, the database being one file for all
// sessions, and `folder` is the row's `directory`, the folder the session is of (see
// `absoluteFolder`), which the hook's `folder` answers with. Null for no row or a row of
// another shape.
function sessionOf(row) {
  if (!row || typeof row.id !== 'string' || !Number.isFinite(row.mtimeMs)) return null;
  return { path: row.id, mtimeMs: row.mtimeMs, size: 0, folder: absoluteFolder(row.directory) };
}

// One row per message of a session with the figures of its `data` column; `summary` is 1 on
// the summary a compaction wrote, `error` the name of the error a message ended with.
function messagesQuery(sessionId) {
  return (
    'SELECT id, ' +
    "json_extract(data, '$.role') AS role, " +
    "json_extract(data, '$.parentID') AS parentId, " +
    'time_created AS created, ' +
    "json_extract(data, '$.time.completed') AS completed, " +
    "json_extract(data, '$.modelID') AS modelId, " +
    "json_extract(data, '$.variant') AS variant, " +
    "(json_extract(data, '$.summary') = 1) AS summary, " +
    "json_extract(data, '$.cost') AS cost, " +
    "json_extract(data, '$.tokens.total') AS total, " +
    "json_extract(data, '$.tokens.input') AS input, " +
    "json_extract(data, '$.tokens.output') AS output, " +
    "json_extract(data, '$.tokens.reasoning') AS reasoning, " +
    "json_extract(data, '$.tokens.cache.read') AS cacheRead, " +
    "json_extract(data, '$.tokens.cache.write') AS cacheWrite, " +
    "json_extract(data, '$.error.name') AS error " +
    `FROM message WHERE session_id = ${literal(sessionId)} ORDER BY time_created, id`
  );
}

// Compactions opencode started by itself (`auto` on the `compaction` part of the user message
// that asked for it) whose summary message came back finished and without an error.
function compactionsQuery(sessionId) {
  const id = literal(sessionId);
  return (
    'SELECT count(*) AS n FROM part AS c JOIN message AS m ' +
    "ON m.session_id = c.session_id AND json_extract(m.data, '$.parentID') = c.message_id " +
    "AND json_extract(m.data, '$.summary') = 1 " +
    `WHERE c.session_id = ${id} AND json_extract(c.data, '$.type') = 'compaction' ` +
    "AND json_extract(c.data, '$.auto') = 1 " +
    "AND json_extract(m.data, '$.time.completed') IS NOT NULL AND json_extract(m.data, '$.error') IS NULL"
  );
}

// Rows of a query as an array: `sqlite3 -json` prints nothing for no rows. Null when the
// program failed (no sqlite3, no database, a table the version lacks).
async function select(run, database, query) {
  const { code, stdout } = await run('sqlite3', ['-readonly', '-json', database, query]);
  if (code !== 0) return null;
  if (stdout.trim() === '') return [];
  const rows = JSON.parse(stdout);
  return Array.isArray(rows) ? rows : null;
}

// How old the last read of a session must be before a change of it is read again (a read at
// most every 10 s while the database keeps changing), and how many sessions' reads are kept.
const REREAD_MS = 10000;
const MAX_CACHED = 8;

// `execOn(machine)`: the plugin's runner bound to an Orca host (null: this computer).
// `readTextOn` is not needed: everything is in the database.
export function createOpencodeSessions({ execOn }) {
  // session key -> { mtimeMs, at, input } of the last successful read, oldest first
  const reads = new Map();
  return {
    // The session the agent's folder links to (see sessionOf) whose id is not in `except`. Null
    // when there is none or the database cannot be read; the newest session of the folder links
    // however long ago it changed (src/core/session-link.js).
    async link({ machine, cwd, home, except }) {
      const rows = await select(execOn(machine), databaseOf(home), sessionQuery(cwd, except));
      return sessionOf(rows?.[0]);
    },

    // The session each of `sessionIds` names, or null: an opencode session id is the `id` of
    // its row, whatever folder the session is of. All null when the database cannot be read.
    async named({ machine, home }, sessionIds) {
      const ids = sessionIds.filter(Boolean);
      const rows = ids.length ? await select(execOn(machine), databaseOf(home), namedQuery(ids)) : [];
      return sessionIds.map((id) => (id ? sessionOf(rows?.find((row) => row.id === id)) : null));
    },

    // The `input` of `readStats('opencode', input, now)` for a linked session. The messages
    // are needed (a failure rejects, so the card reads n/a); a database without the compaction
    // record leaves `compactions` null, and that figure reads n/a alone. The rows are read
    // again only when the session changed since the last read (`file.mtimeMs`, which `link`
    // got from the one-row change check) and that read is at least `REREAD_MS` old; otherwise
    // the input of the last read is returned, so a refresh of a quiet database runs no rows query.
    async read(file, { machine, home, now }) {
      const run = execOn(machine);
      const database = databaseOf(home);
      const key = `${machine ?? ''}\0${database}\0${file.path}`;
      const last = reads.get(key);
      if (last && (last.mtimeMs === file.mtimeMs || now - last.at < REREAD_MS)) return last.input;
      const [messages, counted] = await Promise.all([
        select(run, database, messagesQuery(file.path)),
        select(run, database, compactionsQuery(file.path)).catch(() => null),
      ]);
      if (!messages) throw new Error('opencode messages unreadable');
      const compactions = Number.isFinite(counted?.[0]?.n) ? counted[0].n : null;
      const input = { messages, compactions };
      reads.delete(key);
      reads.set(key, { mtimeMs: file.mtimeMs, at: now, input });
      if (reads.size > MAX_CACHED) reads.delete(reads.keys().next().value);
      return input;
    },

    // The folder the linked session is of, or null: the `directory` of the row that found it,
    // so no program is run.
    async folder(file) {
      return file.folder;
    },
  };
}
