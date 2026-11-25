// Copied from herdr-session-stats (src/providers/opencode-sources.js).
//
// The opencode side of a card's I/O: where opencode keeps a folder's sessions and the rows its
// figures need (src/core/providers/opencode.js reads only values handed in). It is the opencode
// provider's `createSessions` hook (see the stats-shape header of src/core/providers/index.js).
// Runtime-neutral: it takes the plugin's runner bound to an Orca host and runs one read-only
// program there, `sqlite3 -readonly -json <database> <SELECT>`; opencode's own CLI is not run
// and nothing is written. The database and its layout: docs/opencode-session-format.md.

// opencode's database under the host's home folder. opencode follows `XDG_DATA_HOME`; the
// plugin reads the default place only, and an agent whose opencode keeps it elsewhere reads n/a.
const databaseOf = (home) => `${home}/.local/share/opencode/opencode.db`;

// A string as an SQL literal. Folders come from Orca and session ids from the database,
// so no text is put into a query unquoted.
const literal = (text) => `'${String(text).replace(/'/g, "''")}'`;

// The newest session of a folder that is not archived and is not a sub-agent's: opencode
// updates `time_updated` of a session when a message of it changes.
function sessionQuery(cwd) {
  const folder = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
  return (
    'SELECT id, time_updated AS mtimeMs FROM session ' +
    `WHERE directory = ${literal(folder)} AND parent_id IS NULL AND time_archived IS NULL ` +
    'ORDER BY time_updated DESC LIMIT 1'
  );
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
    // The session the agent's folder links to, as `{ path, mtimeMs, size }`: `path` is the
    // session id, which names it on its host, and `size` is 0, the database being one file
    // for all sessions. Null when there is none or the database cannot be read; the newest
    // session of the folder links however long ago it changed (src/core/session-link.js).
    async link({ machine, cwd, home }) {
      const rows = await select(execOn(machine), databaseOf(home), sessionQuery(cwd));
      const row = rows?.[0];
      if (!row || typeof row.id !== 'string' || !Number.isFinite(row.mtimeMs)) return null;
      return { path: row.id, mtimeMs: row.mtimeMs, size: 0 };
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
  };
}
