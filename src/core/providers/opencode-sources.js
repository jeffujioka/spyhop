// Copied from herdr-session-stats (src/providers/opencode-sources.js).
//
// The opencode side of a card's I/O: where opencode keeps a folder's sessions, the rows its
// figures need and the window of its model (src/core/providers/opencode.js reads only values
// handed in). It is the opencode provider's `createSessions` hook (see the stats-shape header of
// src/core/providers/index.js). Runtime-neutral: it takes the plugin's runner and text reader
// bound to an Orca host and runs two read-only programs there, `sqlite3 -readonly -json
// <database> <SELECT>` and `cat -- <catalogue>`; opencode's own CLI is not run and nothing is
// written. The database and its layout: herdr-session-stats docs/opencode-session-format.md for
// the legacy tables (`session`, `message`, `part`), and the header of
// test/fixtures/opencode/current.sql for the current ones (`session_v2`, `session_message`). A
// session is read from the current tables, and from the legacy ones only when the current ones
// do not hold it; its sub-agents are the sessions of the same tables whose `parent_id` leads to
// it. The catalogue is opencode's ~/.cache/opencode/models.json, the shape of which
// test/fixtures/opencode/models.json keeps.

import { createTtlCache } from '../ttl-cache.js';
import { absoluteFolder } from './session-files.js';

// opencode's database under the host's home folder. opencode follows `XDG_DATA_HOME`; the
// plugin reads the default place only, and an agent whose opencode keeps it elsewhere reads n/a.
export const databaseOf = (home) => `${home}/.local/share/opencode/opencode.db`;

// How long a host's model catalogue is kept before it is read again: opencode refreshes the file
// itself now and then, and a new window can wait an hour.
export const CATALOGUE_TTL_MS = 60 * 60 * 1000;

// A string as an SQL literal. Folders and the agents' session ids come from Orca, the other
// session ids from the database, so no text is put into a query unquoted.
const literal = (text) => `'${String(text).replace(/'/g, "''")}'`;

// The sessions as one table: those of the current `session_v2`, and those of the legacy `session`
// whose ids `session_v2` does not hold; `current` is 1 on a row of the current table, and `cost`
// is the session's total cost opencode keeps in it (null on a legacy row). CURRENT and LEGACY
// are the same of a database that has only one of the two tables (see sessionsIn).
const BOTH =
  '(SELECT id, parent_id, directory, title, time_updated, time_archived, 1 AS current, cost FROM session_v2 ' +
  'UNION ALL SELECT id, parent_id, directory, title, time_updated, time_archived, 0 AS current, NULL AS cost FROM session ' +
  'WHERE id NOT IN (SELECT id FROM session_v2))';
const CURRENT = '(SELECT id, parent_id, directory, title, time_updated, time_archived, 1 AS current, cost FROM session_v2)';
const LEGACY = '(SELECT id, parent_id, directory, title, time_updated, time_archived, 0 AS current, NULL AS cost FROM session)';

// Which of the two session tables a database has.
export const SCHEMA_QUERY = "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2', 'session')";

// The sessions (BOTH, CURRENT or LEGACY) of a database whose session tables are the `rows` of
// SCHEMA_QUERY; null when it has neither.
export function sessionsIn(rows) {
  const names = new Set(rows.map((row) => row?.name));
  if (names.has('session_v2')) return names.has('session') ? BOTH : CURRENT;
  return names.has('session') ? LEGACY : null;
}

// The newest session of `sessions` (see sessionsIn) of a folder that is not archived, is not a
// sub-agent's and whose id is not in `except`: opencode updates `time_updated` of a session when
// a message of it changes.
function sessionQuery(sessions, cwd, except = []) {
  const folder = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
  const others = except.length ? `AND id NOT IN (${except.map(literal).join(', ')}) ` : '';
  return (
    `SELECT id, time_updated AS mtimeMs, directory, current, cost FROM ${sessions} ` +
    `WHERE directory = ${literal(folder)} AND parent_id IS NULL AND time_archived IS NULL ${others}` +
    'ORDER BY time_updated DESC LIMIT 1'
  );
}

// Session ids as an SQL list.
const listOf = (ids) => ids.map(literal).join(', ');

// The sessions of `sessions` whose ids are `ids`, whatever their folder.
function namedQuery(sessions, ids) {
  return `SELECT id, time_updated AS mtimeMs, directory, current, cost FROM ${sessions} WHERE id IN (${listOf(ids)})`;
}

// The total cost opencode keeps for the session of a row: that of a current one (null: none).
const loggedCostOf = (row) => (row.current === 1 && Number.isFinite(row.cost) ? row.cost : null);

// A session row as the session `{ path, mtimeMs, size, folder, current, loggedCost }` it links:
// `path` is the session id, which names it on its host, `size` is 0, the database being one file
// for all sessions, `folder` is the row's `directory`, the folder the session is of (see
// `absoluteFolder`), which the hook's `folder` answers with, `current` whether the session is
// read from the current tables, and `loggedCost` the total cost of a current session as opencode
// keeps it (see loggedCostOf). Null for no row or a row of another shape.
function sessionOf(row) {
  if (!row || typeof row.id !== 'string' || !Number.isFinite(row.mtimeMs)) return null;
  return { path: row.id, mtimeMs: row.mtimeMs, size: 0, folder: absoluteFolder(row.directory), current: row.current === 1, loggedCost: loggedCostOf(row) };
}

// The sub-agents of the session `parentId`: every session of the same generation of tables
// (`current`) whose `parent_id` leads to it, directly or through other sub-agents, in the order
// they were created, with its title, its agent kind (`agent`), the id of its model (`model`,
// JSON), the time it last changed and, for `loggedCostOf`, its total cost. Without `told`, the
// agent and the model are null: the legacy `session` of older opencode versions has neither
// column. `UNION` keeps a session reached twice once.
function descendantsQuery(current, parentId, told) {
  const sessions = current ? 'session_v2' : 'session';
  return (
    `WITH RECURSIVE tree(id) AS (SELECT id FROM ${sessions} WHERE parent_id = ${literal(parentId)} ` +
    `UNION SELECT s.id FROM ${sessions} AS s JOIN tree ON s.parent_id = tree.id) ` +
    `SELECT s.id, s.title, ${told ? "s.agent, json_extract(s.model, '$.id') AS model" : 'NULL AS agent, NULL AS model'}, ` +
    `s.time_updated AS mtimeMs, ${current ? '1 AS current, s.cost' : '0 AS current, NULL AS cost'} ` +
    `FROM ${sessions} AS s JOIN tree USING (id) ORDER BY s.time_created, s.id`
  );
}

// One row per message of the legacy sessions `ids` with the figures of its `data` column, those
// of each session in order; `sessionId` is the session's, `summary` is 1 on the summary a
// compaction wrote, `error` the name of the error a message ended with.
function messagesQuery(ids) {
  return (
    'SELECT id, session_id AS sessionId, ' +
    "json_extract(data, '$.role') AS role, " +
    "json_extract(data, '$.parentID') AS parentId, " +
    'time_created AS created, ' +
    "json_extract(data, '$.time.completed') AS completed, " +
    "json_extract(data, '$.modelID') AS modelId, " +
    "json_extract(data, '$.providerID') AS providerId, " +
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
    `FROM message WHERE session_id IN (${listOf(ids)}) ORDER BY session_id, time_created, id`
  );
}

// The same rows of current sessions, from their `session_message` rows of the types `user`,
// `assistant` and `compaction`. A compaction is a row of its own there, with the model, the cost
// and the tokens of the call that wrote the summary, which the session's cost counts: it is the
// assistant row with `summary` 1 the legacy tables write for it. The current rows name no message
// a reply answers (`parentId`) and log no token total (`total`), and `error` is the type of the
// error a message ended with.
function currentMessagesQuery(ids) {
  return (
    'SELECT id, session_id AS sessionId, ' +
    "CASE type WHEN 'compaction' THEN 'assistant' ELSE type END AS role, " +
    'NULL AS parentId, ' +
    'time_created AS created, ' +
    "json_extract(data, '$.time.completed') AS completed, " +
    "json_extract(data, '$.model.id') AS modelId, " +
    "json_extract(data, '$.model.providerID') AS providerId, " +
    "json_extract(data, '$.model.variant') AS variant, " +
    "(type = 'compaction') AS summary, " +
    "json_extract(data, '$.cost') AS cost, " +
    'NULL AS total, ' +
    "json_extract(data, '$.tokens.input') AS input, " +
    "json_extract(data, '$.tokens.output') AS output, " +
    "json_extract(data, '$.tokens.reasoning') AS reasoning, " +
    "json_extract(data, '$.tokens.cache.read') AS cacheRead, " +
    "json_extract(data, '$.tokens.cache.write') AS cacheWrite, " +
    "json_extract(data, '$.error.type') AS error " +
    `FROM session_message WHERE session_id IN (${listOf(ids)}) ` +
    "AND type IN ('user', 'assistant', 'compaction') ORDER BY session_id, seq"
  );
}

// The columns of historyRowsQuery's rows.
const HISTORY_COLUMNS = [
  'id',
  'created',
  'sessionId',
  'ownId',
  'parentId',
  'title',
  'directory',
  'role',
  'own',
  'modelId',
  'providerId',
  'cost',
  'total',
  'input',
  'output',
  'reasoning',
  'cacheRead',
  'cacheWrite',
  'completed',
  'toolStart',
  'finish',
  'summary',
  'name',
  'start',
  'end',
  'status',
  'child',
];

// The rows the history store keeps of `sessions` (see sessionsIn), created from `fromMs` on (epoch
// ms), after the row `afterId` of that time when given, `limit` of them (-1: all), by `created`
// and `id`, those of the root sessions `roots` only when given; a legacy session the current tables
// hold is read from them. Only the fields of the figures, of the Trace and of the session's
// summary are read, never a message's text. Each row is one of:
//   - a model call (`role` 'assistant'): the current tables' `assistant` and `compaction` rows and
//     the legacy tables' assistant messages, a compaction's summary (`summary` 1) included, with
//     `modelId, providerId, cost, total, input, output, reasoning, cacheRead, cacheWrite`, the time
//     it `completed`, `toolStart`, the time the first of its tool calls started (null without
//     one), why it finished (`finish`, opencode's `tool-calls` for a step that calls tools) and
//     `summary` 1 on a compaction's summary;
//   - a user message (`role` 'user');
//   - a tool call (`role` 'tool') of the message `created` and `completed`, of the tool `name`, that
//     ran from `start` to `end` as opencode logs them (the current tables: its `time.ran`, else its
//     `time.created`, to its `time.completed`; the legacy ones: its `state.time.start` to its
//     `state.time.end`), each null when not logged, with its `state.status` (`status`) and the
//     session it started (`child`, its `state.metadata.sessionID`), null when none.
// `id` is the message's (a current tool call's with its place in the message's `content`, a legacy
// one's that of its part), `created` the time the message was created, `sessionId` the session's
// root (its `parent_id` followed to a session without one, or whose parent the database lacks),
// `ownId`, `parentId`, `title` and `directory` the id, the parent's id, the title and the folder
// of the row's own session, and `own` 1 when that session is the root.
/** @param {string[] | null} [roots] */
export function historyRowsQuery(sessions, fromMs, afterId, limit, roots = null) {
  const from = Number(fromMs);
  // the trees of `roots` only, filtered once, where the tree starts
  const inRoots = roots === null ? '' : ` AND id IN (${listOf(roots)})`;
  const after = (id) => (afterId === null ? `m.time_created >= ${from}` : `(m.time_created > ${from} OR (m.time_created = ${from} AND ${id} > ${literal(afterId)}))`);
  // the row of `values` (column -> SQL), NULL in the columns it does not give
  const row = (values) => HISTORY_COLUMNS.map((name) => `${values[name] ?? 'NULL'} AS "${name}"`).join(', ');
  const json = (path, of = 'm.data') => `json_extract(${of}, '$.${path}')`;
  const message = (role) => ({
    id: 'm.id',
    created: 'm.time_created',
    sessionId: 'tree.root',
    ownId: 'tree.id',
    parentId: 'tree.parent',
    title: 'tree.title',
    directory: 'tree.directory',
    role: literal(role),
    own: '(tree.id = tree.root)',
    completed: json('time.completed'),
  });
  const call = (model, provider, total, toolStart, summary) => ({
    ...message('assistant'),
    modelId: json(model),
    providerId: json(provider),
    cost: json('cost'),
    total,
    ...Object.fromEntries(['input', 'output', 'reasoning'].map((name) => [name, json(`tokens.${name}`)])),
    cacheRead: json('tokens.cache.read'),
    cacheWrite: json('tokens.cache.write'),
    toolStart,
    finish: json('finish'),
    summary,
  });
  const currentTool = `coalesce(${json('time.ran', 'c.value')}, ${json('time.created', 'c.value')})`;
  const currentJoin = 'FROM session_message AS m JOIN tree ON tree.id = m.session_id AND tree.current = 1';
  const current = [
    `SELECT ${row(call('model.id', 'model.providerID', 'NULL', `(SELECT min(${currentTool}) FROM json_each(m.data, '$.content') AS c WHERE ${json('type', 'c.value')} = 'tool')`, "(m.type = 'compaction')"))} ` +
      `${currentJoin} WHERE m.type IN ('assistant', 'compaction') AND ${after('m.id')}`,
    `SELECT ${row(message('user'))} ${currentJoin} WHERE m.type = 'user' AND ${after('m.id')}`,
    `SELECT ${row({
      ...message('tool'),
      id: "m.id || '/' || c.key",
      name: json('name', 'c.value'),
      start: currentTool,
      end: json('time.completed', 'c.value'),
      status: json('state.status', 'c.value'),
      child: json('state.metadata.sessionID', 'c.value'),
    })} ` + `${currentJoin}, json_each(m.data, '$.content') AS c WHERE m.type = 'assistant' AND ${json('type', 'c.value')} = 'tool' AND ${after("m.id || '/' || c.key")}`,
  ];
  const legacyJoin = 'FROM message AS m JOIN tree ON tree.id = m.session_id AND tree.current = 0';
  const legacy = [
    `SELECT ${row(call('modelID', 'providerID', json('tokens.total'), `(SELECT min(${json('state.time.start', 'p.data')}) FROM part AS p WHERE p.message_id = m.id AND ${json('type', 'p.data')} = 'tool')`, `(${json('summary')} = 1)`))} ` +
      `${legacyJoin} WHERE ${json('role')} = 'assistant' AND ${after('m.id')}`,
    `SELECT ${row(message('user'))} ${legacyJoin} WHERE ${json('role')} = 'user' AND ${after('m.id')}`,
    `SELECT ${row({
      ...message('tool'),
      id: 'p.id',
      name: json('tool', 'p.data'),
      start: json('state.time.start', 'p.data'),
      end: json('state.time.end', 'p.data'),
      status: json('state.status', 'p.data'),
      child: json('state.metadata.sessionID', 'p.data'),
    })} ` + `${legacyJoin} JOIN part AS p ON p.message_id = m.id WHERE ${json('type', 'p.data')} = 'tool' AND ${after('p.id')}`,
  ];
  const parts = { [BOTH]: [...current, ...legacy], [CURRENT]: current, [LEGACY]: legacy }[sessions];
  return (
    `WITH RECURSIVE s AS ${sessions}, tree(id, root, parent, title, directory, current) AS (` +
    `SELECT id, id, NULL, title, directory, current FROM s WHERE (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM s))${inRoots} ` +
    'UNION SELECT s.id, tree.root, s.parent_id, s.title, s.directory, s.current FROM s JOIN tree ON s.parent_id = tree.id) ' +
    `${parts.join(' UNION ALL ')} ORDER BY created, id LIMIT ${Number(limit)}`
  );
}

// The compactions of each of the legacy sessions `ids` opencode started by itself (`auto` on the
// `compaction` part of the user message that asked for it) whose summary message came back
// finished and without an error: a row `{ sessionId, n }` of each session that has any.
function compactionsQuery(ids) {
  return (
    'SELECT c.session_id AS sessionId, count(*) AS n FROM part AS c JOIN message AS m ' +
    "ON m.session_id = c.session_id AND json_extract(m.data, '$.parentID') = c.message_id " +
    "AND json_extract(m.data, '$.summary') = 1 " +
    `WHERE c.session_id IN (${listOf(ids)}) AND json_extract(c.data, '$.type') = 'compaction' ` +
    "AND json_extract(c.data, '$.auto') = 1 " +
    "AND json_extract(m.data, '$.time.completed') IS NOT NULL AND json_extract(m.data, '$.error') IS NULL " +
    'GROUP BY c.session_id'
  );
}

// The tool calls of the legacy sessions `ids`, `{ sessionId, name, status }` each, those of each
// session in order: their `part` rows of the type `tool`.
function toolsQuery(ids) {
  return (
    "SELECT session_id AS sessionId, json_extract(data, '$.tool') AS name, json_extract(data, '$.state.status') AS status " +
    `FROM part WHERE session_id IN (${listOf(ids)}) AND json_extract(data, '$.type') = 'tool' ` +
    'ORDER BY session_id, time_created, id'
  );
}

// The same of current sessions: the `tool` items of the `content` of their assistant rows.
function currentToolsQuery(ids) {
  return (
    "SELECT m.session_id AS sessionId, json_extract(c.value, '$.name') AS name, json_extract(c.value, '$.state.status') AS status " +
    "FROM session_message AS m, json_each(m.data, '$.content') AS c " +
    `WHERE m.session_id IN (${listOf(ids)}) AND m.type = 'assistant' ` +
    "AND json_extract(c.value, '$.type') = 'tool' ORDER BY m.session_id, m.seq, c.key"
  );
}

// Rows of a query as an array: `sqlite3 -json` prints nothing for no rows. Null when the
// program failed (no sqlite3, no database, a table the version lacks).
export async function select(run, database, query) {
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

// The key of the session `id` of `database` on `machine` among the reads kept, read from the
// current tables or the legacy ones (`current`): a session opencode has since written into the
// current tables is read from them at once, never served the rows of its legacy copy.
const keyOf = (machine, database, id, current) => `${machine ?? ''}\0${database}\0${id}\0${current ? 1 : 0}`;

// Keeps `value` under `key` as the newest of `cache`, which holds at most MAX_CACHED, oldest first.
function remember(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
}

// `rows` of the sessions `ids` by their `sessionId`, each session's in their order.
function bySession(rows, ids) {
  const grouped = new Map(ids.map((id) => [id, []]));
  for (const row of rows) grouped.get(row?.sessionId)?.push(row);
  return grouped;
}

// The rows of each of the sessions `ids` of one generation of tables (`current`), `{ messages,
// compactions, tools }` by session id, from one query of each kind for all of them. The messages
// are needed (a failure rejects); tool calls that cannot be read leave `tools` null; the
// compaction record is the legacy tables': current sessions, or a database without that record,
// leave `compactions` null.
async function inputsOf(run, database, ids, current) {
  const [messages, tools, counted] = await Promise.all([
    select(run, database, (current ? currentMessagesQuery : messagesQuery)(ids)),
    select(run, database, (current ? currentToolsQuery : toolsQuery)(ids)).catch(() => null),
    current ? null : select(run, database, compactionsQuery(ids)).catch(() => null),
  ]);
  if (!messages) throw new Error('opencode messages unreadable');
  const rows = bySession(messages, ids);
  const calls = tools && bySession(tools, ids);
  const compacted = counted && bySession(counted, ids);
  return new Map(
    ids.map((id) => [id, { messages: rows.get(id), compactions: compacted ? (compacted.get(id)[0]?.n ?? 0) : null, tools: calls ? calls.get(id) : null }]),
  );
}

// opencode's model catalogue under the host's home folder, which opencode fetches and keeps
// itself: `<providerID>.models.<modelID>.limit.context` is a model's window.
const catalogueOf = (home) => `${home}/.cache/opencode/models.json`;

// The latest model call of `messages` that is no compaction summary (a summary has its own
// model; the context is that of the turns around it, see opencode.js), or undefined.
const latestTurn = (messages) => messages.findLast((row) => row?.role === 'assistant' && row.summary !== 1 && typeof row.modelId === 'string');

// The window of the latest turn of `messages` (see latestTurn) from `catalogue`; null when the
// catalogue holds none above 0 for its provider and model.
function windowOf(catalogue, messages) {
  const turn = latestTurn(messages);
  if (!turn || typeof turn.providerId !== 'string') return null;
  const window = catalogue?.[turn.providerId]?.models?.[turn.modelId]?.limit?.context;
  return Number.isFinite(window) && window > 0 ? window : null;
}

// `execOn(machine)` and `readTextOn(machine)`: the plugin's runner and text reader bound to an
// Orca host (null: this computer). The sessions are in the database; the catalogue is a file.
export function createOpencodeSessions({ execOn, readTextOn }) {
  // session key -> { mtimeMs, at, input } of the last successful read, oldest first
  const reads = new Map();
  // session key -> { stamp, at, inputs } of the last successful read of its sub-agents' rows:
  // `stamp` names each sub-agent and the time it last changed, `inputs` is inputsOf's
  const subReads = new Map();
  // each machine's catalogue, read with `cat`, again only after CATALOGUE_TTL_MS
  const catalogues = createTtlCache(CATALOGUE_TTL_MS);
  // machine and database -> the promise of its sessions (see sessionsIn) from one lookup of its
  // schema, kept until a query of them fails: after a lookup that failed or found neither table,
  // a busy database or an opencode that changed its tables, the next refresh looks again. Only
  // BOTH and CURRENT are kept: opencode adds its current tables to a legacy-only database in
  // place, and a kept LEGACY would never see a session written there, so such a database is
  // looked up again at each refresh.
  const schemas = new Map();

  // Rows of `query(sessions)` of the sessions of `database` on `machine` (see sessionsIn); null
  // when the database cannot be read.
  async function sessionRows(machine, database, query) {
    const run = execOn(machine);
    const key = `${machine ?? ''}\0${database}`;
    let sessions = schemas.get(key);
    if (!sessions) {
      sessions = select(run, database, SCHEMA_QUERY).then((rows) => rows && sessionsIn(rows), () => null);
      schemas.set(key, sessions);
    }
    const table = await sessions;
    const rows = table && (await select(run, database, query(table)).catch(() => null));
    if ((!rows || table === LEGACY) && schemas.get(key) === sessions) schemas.delete(key);
    return rows;
  }

  // The parsed catalogue of a machine, or null when it is not there or does not parse, which is
  // kept like a catalogue read. A host ssh could not reach rejects (see readTextOn), which is not
  // kept, so the next refresh reads it again.
  function readCatalogue(machine, home, now) {
    const path = catalogueOf(home);
    return catalogues(`${machine ?? ''}\0${path}`, now, async () => {
      const text = await readTextOn(machine)(path);
      if (text === null) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    });
  }

  // The rows of a linked session (see `read`).
  async function rowsOf(file, { machine, home, now }) {
    const database = databaseOf(home);
    const key = keyOf(machine, database, file.path, file.current);
    const last = reads.get(key);
    if (last && (last.mtimeMs === file.mtimeMs || now - last.at < REREAD_MS)) return last.input;
    const rows = (await inputsOf(execOn(machine), database, [file.path], file.current)).get(file.path);
    const input = { ...rows, loggedCost: file.loggedCost ?? null };
    remember(reads, key, { mtimeMs: file.mtimeMs, at: now, input });
    return input;
  }

  return {
    // The session the agent's folder links to (see sessionOf) whose id is not in `except`. Null
    // when there is none or the database cannot be read; the newest session of the folder links
    // however long ago it changed (src/core/session-link.js).
    async link({ machine, cwd, home, except }) {
      const rows = await sessionRows(machine, databaseOf(home), (sessions) => sessionQuery(sessions, cwd, except));
      return sessionOf(rows?.[0]);
    },

    // The session each of `sessionIds` names, or null: an opencode session id is the `id` of
    // its row, whatever folder the session is of. All null when the database cannot be read.
    async named({ machine, home }, sessionIds) {
      const ids = sessionIds.filter(Boolean);
      const rows = ids.length ? await sessionRows(machine, databaseOf(home), (sessions) => namedQuery(sessions, ids)) : [];
      return sessionIds.map((id) => (id ? sessionOf(rows?.find((row) => row.id === id)) : null));
    },

    // The `input` of `readStats('opencode', input, now)` for a linked session, from the tables
    // it was found in (`file.current`), with the total cost `link` or `named` found kept for it
    // (`file.loggedCost`). The messages are needed (a failure rejects, so the card reads n/a);
    // tool calls that cannot be read leave `tools` null, and the series of the session alone
    // reads n/a. The compaction record is the legacy tables': a current session, or a database
    // without that record, leaves `compactions` null, and that figure reads n/a alone. The rows
    // are read again only when the session changed since the last read (`file.mtimeMs`, which
    // `link` got from the one-row change check) and that read is at least `REREAD_MS` old;
    // otherwise the input of the last read is returned, so a refresh of a quiet database runs no
    // rows query. `sources.window` is the window of the session's model in the host's catalogue
    // (see windowOf), null when it cannot be read. The catalogue read is waited for even when the
    // rows read fails, so that no program of a refresh is still running once it is over.
    async read(file, where) {
      const catalogue = readCatalogue(where.machine, where.home, where.now).catch(() => null);
      const input = await rowsOf(file, where).finally(() => catalogue);
      return { ...input, sources: { window: windowOf(await catalogue, input.messages) } };
    },

    // The folder the linked session is of, or null: the `directory` of the row that found it,
    // so no program is run.
    async folder(file) {
      return file.folder;
    },

    // The sub-agents of a linked session: its child sessions in the tables it was found in,
    // children's children included, from one query (see descendantsQuery), each with the
    // `input` of `read`, all of their rows read by one query of each kind (see inputsOf). Those
    // rows are read again only when a sub-agent was added or changed since the last read and
    // that read is at least `REREAD_MS` old, as a session's are; one added since is then not
    // read yet (`input` null). Each is named by its title (its id without one); its kind is its
    // `agent`, its model its `model`, else that of its latest turn (see latestTurn), and its
    // total cost the one opencode keeps for a current session (see loggedCostOf). A listing that
    // fails is tried again without `agent` and `model`, as a database whose legacy `session`
    // lacks them fails it; the kind is then not told (null). opencode does not tell whether a
    // sub-agent runs, nor its task, so they are null. A session without child sessions has none;
    // a listing or a rows read that fails rejects, since its sub-agents are then unknown, not none.
    async subagents(file, { machine, home, now }) {
      const run = execOn(machine);
      const database = databaseOf(home);
      const listing = (told) => select(run, database, descendantsQuery(file.current, file.path, told));
      const listed = (await listing(true)) ?? (await listing(false));
      if (!listed) throw new Error('opencode sub-agents unreadable');
      const children = listed.filter((row) => typeof row?.id === 'string');
      if (children.length === 0) return [];
      const key = keyOf(machine, database, file.path, file.current);
      const stamp = children.map(({ id, mtimeMs }) => `${id}\0${mtimeMs}`).join('\n');
      const last = subReads.get(key);
      let inputs = last?.inputs;
      if (!last || (last.stamp !== stamp && now - last.at >= REREAD_MS)) {
        inputs = await inputsOf(run, database, children.map(({ id }) => id), file.current);
        remember(subReads, key, { stamp, at: now, inputs });
      }
      const catalogue = await readCatalogue(machine, home, now).catch(() => null);
      return children.map((row) => {
        const rows = inputs.get(row.id);
        const input = rows ? { ...rows, loggedCost: loggedCostOf(row), sources: { window: windowOf(catalogue, rows.messages) } } : null;
        const model = row.model ?? (rows ? latestTurn(rows.messages)?.modelId : null) ?? null;
        return { name: row.title ?? row.id, kind: row.agent ?? null, model, task: null, running: null, input };
      });
    },
  };
}
