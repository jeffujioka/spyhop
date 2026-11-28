// The history store: the SQLite file under the home that keeps, for good, what a catch-up read
// of the session files: the daily lines of their model calls, each session's summary and Trace,
// and, for each file, how far it was read and the state of its provider's fold there.
//
// - `files`: one row per session file of an Orca host and harness, with the position the read
//   reached, the size and mtime it saw, the HISTORY_VERSION that wrote its state, and that
//   state as JSON (`encodeState` of src/core/refresh.js); an opencode database is one row, whose
//   lines a catch-up replaces from a day on (`replaceDays`);
// - `lines`: the figures (LINE_FIGURES) of a file's model calls by session, day, repo and model;
// - `sessions`: one row per session that is not a sub-agent, by its id (`<host>\0<harness>\0<main
//   session file or opencode root session id>`), with the file it was read from, its title, repo,
//   first and last time, its own cost (and how many of its calls have none), tokens and models,
//   its Trace lanes and the statuses its harness logged of the sub-agents it started;
// - `subagents`: one row per sub-agent of a session, by its key in it (omp: its name, Claude Code:
//   the id of the tool use that started it, opencode: its session id), with the file it was read
//   from, the key of the agent that started it (null: the main agent), its name, times, cost,
//   tokens, models, whether it runs (null: not known) and the statuses it logged of its own;
// - `meta`: string values by key; `host-keys` set to `machine-id` once the rows of another Orca
//   host are keyed by the machine it reaches, `machine:<identity>:<home>`
//   (src/history/catch-up.ts), not by its ssh alias, `ssh:<alias>`, as HISTORY_VERSION 3 kept
//   them, nor by its node name, `machine:<node name>`, as `host-keys` `machine` marked;
// - the view `daily_lines`: the lines summed by day, Orca host, repo, harness and model.
//
// No text of a prompt, a reply, a task or a tool call is kept: names, counts, times and money only.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LINE_FIGURES } from '../core/insights.js';
import { decodeState, encodeState } from '../core/refresh.js';
import { traceOf } from '../core/trace.js';
import { LOCAL } from '../fleet.ts';
import type { SessionSummary, TraceView } from '../protocol.ts';

export const STORE_FILE = '.local/state/spyhop/insights.db';

// The version of the file rows' states: a reader takes a row of another version as unread.
// Raise it with KEPT_VERSION (src/core/refresh.js) when a fold's state changes shape, and alone
// when only the insights a fold keeps for the store change (3: the Trace lanes; 4: another Orca
// host's rows keyed by its machine; 5: the session summaries and sub-agent rows).
export const HISTORY_VERSION = 5;

export type FileRow = { id: number; host: string; harness: string; path: string; pos: number; size: number; mtimeMs: number; version: number; state: unknown };

// A file's row without its state, which is decoded only for a file that will be read.
export type FileMark = Omit<FileRow, 'state'>;

export type DailyLine = { day: string; host: string; repo: string; harness: string; model: string; figures: Record<string, number> };

// A daily line of one read (`takeLines` of src/core/insights.js).
type LineDelta = { day: string; model: string; figures: Record<string, number> };

// A daily line of one read, with the session and the repo it counts in.
export type SessionLine = LineDelta & { session: string; repo: string };

// A Trace lane as a session's row keeps it.
type Lane = { spans: [number, number][]; totalMs: number };

// The Trace lanes of a session (see newInsights of src/core/insights.js).
export type Lanes = { thinking: Lane; tools: Lane; busy: Lane; developer: Lane };

// What a session's summary and its sub-agents' rows share: the first and last time (null: none),
// the own cost, USD, and how many calls have none, the tokens, the models, and the statuses it
// logged of the sub-agents it started, by their keys.
type Figures = { startMs: number | null; endMs: number | null; cost: number; costNa: number; tokens: number; models: string[]; statuses: Map<string, string> };

// The row of a session that is not a sub-agent: its title, repo and Trace lanes.
export type SessionRow = Figures & { title: string; repo: string; lanes: Lanes };

// The row of a sub-agent: its key, the key of the agent that started it (null: the main agent),
// its name and whether it runs (null: not known).
export type AgentRow = Figures & { key: string; parent: string | null; name: string; running: boolean | null };

export type Store = {
  // The row of the file `path` of `harness` on the Orca host `host`, but its state; null when
  // none was saved.
  file(host: string, harness: string, path: string): FileMark | null;
  // The state of the file of id `id`.
  state(id: number): unknown;
  // Saves a read of a file of session `session` in `repo`, in one transaction: its lines added to
  // the file's (which a `restarted` read replaces, with its session's and sub-agent's rows) and its
  // row, with the row of its session (`main`) or of the sub-agent it is (`agent`) when given.
  // Returns the file's id.
  saveRead(file: Omit<FileRow, 'id'>, read: { session: string; repo: string; lines: LineDelta[]; restarted: boolean; main?: SessionRow; agent?: AgentRow }): number;
  // Replaces the lines of the file of id `file` of the day `fromDay` (YYYY-MM-DD) and later with
  // `read.lines`, in one transaction; '' replaces them all.
  replaceDays(file: number, fromDay: string, read: { lines: SessionLine[] }): void;
  // Replaces the row of the session `session` read from the file of id `file` with `main`, and its
  // sub-agents' rows with `agents`, in one transaction.
  saveSession(file: number, session: string, main: SessionRow, agents: AgentRow[]): void;
  // The daily lines of the days `from` to `to` (YYYY-MM-DD, both included).
  dailyLines(from: string, to: string): DailyLine[];
  // The summary of the session `id`, its sub-agents counted in it; null when none is kept. A
  // Claude Code session's own cost holds its sub-agents' already.
  summary(id: string): SessionSummary | null;
  // The Trace of the session `id` (traceOf of src/core/trace.js), from its first to its last
  // time; null when none is kept, or it has no time.
  trace(id: string): TraceView | null;
  meta(key: string): string | null;
  setMeta(key: string, value: string): void;
  close(): void;
};

// The figure columns, quoted: `read` and `write` read as words of SQL otherwise.
const COLUMNS = LINE_FIGURES.map((name) => `"${name}"`);

// How long a statement waits for another process that holds the store.
const BUSY_MS = 5000;

// Opens the store of the home `home`, making its folder and file when missing, and adds each
// figure column its lines lack, 0 in the lines it holds. A statement waits up to BUSY_MS for
// another process that holds the store, such as a test run beside the plugin or `sqlite3`.
// `node:sqlite` is loaded here, so that a Node that cannot load it rejects the open, as a store
// that cannot be opened does, instead of failing the worker's load.
export async function openStore(home: string): Promise<Store> {
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(home, STORE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // a file that is not a store, or a schema that cannot be made, rejects the open with it closed
  try {
    db.exec(`PRAGMA busy_timeout=${BUSY_MS}`);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY, host TEXT NOT NULL, harness TEXT NOT NULL, path TEXT NOT NULL,
        pos INTEGER NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL,
        UNIQUE (host, harness, path));
      CREATE TABLE IF NOT EXISTS lines (
        file INTEGER NOT NULL REFERENCES files (id), session TEXT NOT NULL, day TEXT NOT NULL, repo TEXT NOT NULL, model TEXT NOT NULL,
        PRIMARY KEY (file, session, day, repo, model));
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, file INTEGER NOT NULL REFERENCES files (id), host TEXT NOT NULL, harness TEXT NOT NULL, title TEXT NOT NULL, repo TEXT NOT NULL,
        start_ms REAL, end_ms REAL, own_cost REAL NOT NULL, own_cost_na INTEGER NOT NULL, tokens INTEGER NOT NULL, models TEXT NOT NULL, lanes TEXT NOT NULL,
        statuses TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_file ON sessions (file);
      CREATE TABLE IF NOT EXISTS subagents (
        session TEXT NOT NULL, key TEXT NOT NULL, file INTEGER NOT NULL REFERENCES files (id), parent TEXT, name TEXT NOT NULL,
        start_ms REAL, end_ms REAL, cost REAL NOT NULL, cost_na INTEGER NOT NULL, tokens INTEGER NOT NULL, models TEXT NOT NULL, running INTEGER,
        statuses TEXT NOT NULL,
        PRIMARY KEY (session, key));
      CREATE INDEX IF NOT EXISTS subagents_file ON subagents (file);
    `);
    const has = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all('lines').map((column) => column.name));
    for (const name of LINE_FIGURES) {
      if (!has.has(name)) db.exec(`ALTER TABLE lines ADD COLUMN "${name}" ${name === 'cost' ? 'REAL' : 'INTEGER'} NOT NULL DEFAULT 0`);
    }
    db.exec(`
      DROP VIEW IF EXISTS daily_lines;
      CREATE VIEW daily_lines AS
        SELECT day, host, repo, harness, model, ${COLUMNS.map((column) => `SUM(${column}) AS ${column}`).join(', ')}
        FROM lines JOIN files ON files.id = lines.file
        GROUP BY day, host, repo, harness, model;
    `);
    // once: the rows, and the read-through marks, of every Orca host but this computer, all keyed
    // by an older key, which the next catch-up reads again, once each
    if (db.prepare("SELECT value FROM meta WHERE key = 'host-keys'").get()?.value !== 'machine-id') {
      const other = `host != '${LOCAL}'`;
      db.exec(`
        BEGIN;
        DELETE FROM lines WHERE file IN (SELECT id FROM files WHERE ${other});
        DELETE FROM files WHERE ${other};
        DELETE FROM meta WHERE key LIKE 'read:%' AND key NOT LIKE 'read:${LOCAL}:%';
        INSERT INTO meta (key, value) VALUES ('host-keys', 'machine-id') ON CONFLICT (key) DO UPDATE SET value = excluded.value;
        COMMIT;
      `);
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const selectFile = db.prepare('SELECT id, host, harness, path, pos, size, mtime_ms, version FROM files WHERE host = ? AND harness = ? AND path = ?');
  const selectState = db.prepare('SELECT state FROM files WHERE id = ?');
  const upsertFile = db.prepare(`
    INSERT INTO files (host, harness, path, pos, size, mtime_ms, version, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (host, harness, path) DO UPDATE SET
      pos = excluded.pos, size = excluded.size, mtime_ms = excluded.mtime_ms, version = excluded.version, state = excluded.state
    RETURNING id`);
  const deleteLines = db.prepare('DELETE FROM lines WHERE file = ?');
  const deleteDays = db.prepare('DELETE FROM lines WHERE file = ? AND day >= ?');
  const upsertLine = db.prepare(`
    INSERT INTO lines (file, session, day, repo, model, ${COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?, ${COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT (file, session, day, repo, model) DO UPDATE SET ${COLUMNS.map((column) => `${column} = ${column} + excluded.${column}`).join(', ')}`);
  const selectLines = db.prepare('SELECT * FROM daily_lines WHERE day BETWEEN ? AND ? ORDER BY day, host, repo, harness, model');
  const selectMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const upsertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  const deleteSessions = db.prepare('DELETE FROM sessions WHERE file = ?');
  const deleteAgentsOf = db.prepare('DELETE FROM subagents WHERE file = ?');
  const deleteAgents = db.prepare('DELETE FROM subagents WHERE session = ?');
  const upsertSession = db.prepare(`
    INSERT OR REPLACE INTO sessions (id, file, host, harness, title, repo, start_ms, end_ms, own_cost, own_cost_na, tokens, models, lanes, statuses)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upsertAgent = db.prepare(`
    INSERT OR REPLACE INTO subagents (session, key, file, parent, name, start_ms, end_ms, cost, cost_na, tokens, models, running, statuses)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const selectSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const selectAgents = db.prepare('SELECT * FROM subagents WHERE session = ?');

  // The statuses of a row as it keeps them, and back.
  const statusesText = (statuses: Map<string, string>) => JSON.stringify(Object.fromEntries(statuses));
  const statusesOf = (text: unknown) => Object.entries(JSON.parse(String(text)) as Record<string, string>);
  // A time column's value: null when none.
  const timeOf = (value: unknown) => (value === null ? null : Number(value));

  function saveSessionRow(file: number, session: string, { title, repo, startMs, endMs, cost, costNa, tokens, models, lanes, statuses }: SessionRow) {
    const [host, harness] = session.split('\0');
    // the lanes without the gaps they joined, which only a read to come adds to
    const kept = Object.fromEntries(Object.entries(lanes).map(([name, { spans, totalMs }]) => [name, { spans, totalMs }]));
    upsertSession.run(session, file, host, harness, title, repo, startMs, endMs, cost, costNa, tokens, JSON.stringify(models), JSON.stringify(kept), statusesText(statuses));
  }

  function saveAgentRow(file: number, session: string, { key, parent, name, startMs, endMs, cost, costNa, tokens, models, running, statuses }: AgentRow) {
    upsertAgent.run(session, key, file, parent, name, startMs, endMs, cost, costNa, tokens, JSON.stringify(models), running === null ? null : Number(running), statusesText(statuses));
  }

  // Runs `write` in one transaction; what it returns.
  function inTransaction<Result>(write: () => Result) {
    db.exec('BEGIN');
    try {
      const result = write();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    file(host, harness, path) {
      const row = selectFile.get(host, harness, path);
      if (!row) return null;
      return {
        id: Number(row.id),
        host: String(row.host),
        harness: String(row.harness),
        path: String(row.path),
        pos: Number(row.pos),
        size: Number(row.size),
        mtimeMs: Number(row.mtime_ms),
        version: Number(row.version),
      };
    },
    state(id) {
      return decodeState(JSON.parse(String(selectState.get(id)!.state)));
    },
    saveRead(file, { session, repo, lines, restarted, main, agent }) {
      return inTransaction(() => {
        const id = Number(upsertFile.get(file.host, file.harness, file.path, file.pos, file.size, file.mtimeMs, file.version, JSON.stringify(encodeState(file.state)))!.id);
        if (restarted) {
          deleteLines.run(id);
          deleteSessions.run(id);
          deleteAgentsOf.run(id);
        }
        for (const { day, model, figures } of lines) upsertLine.run(id, session, day, repo, model, ...LINE_FIGURES.map((name) => figures[name]));
        if (main) saveSessionRow(id, session, main);
        if (agent) saveAgentRow(id, session, agent);
        return id;
      });
    },
    replaceDays(file, fromDay, { lines }) {
      inTransaction(() => {
        deleteDays.run(file, fromDay);
        for (const { session, day, repo, model, figures } of lines) upsertLine.run(file, session, day, repo, model, ...LINE_FIGURES.map((name) => figures[name]));
      });
    },
    saveSession(file, session, main, agents) {
      inTransaction(() => {
        saveSessionRow(file, session, main);
        deleteAgents.run(session);
        for (const agent of agents) saveAgentRow(file, session, agent);
      });
    },
    dailyLines(from, to) {
      return selectLines.all(from, to).map((row) => ({
        day: String(row.day),
        host: String(row.host),
        repo: String(row.repo),
        harness: String(row.harness),
        model: String(row.model),
        figures: Object.fromEntries(LINE_FIGURES.map((name) => [name, Number(row[name])])),
      }));
    },
    summary(id) {
      const row = selectSession.get(id);
      if (!row) return null;
      const agents = selectAgents.all(id);
      const harness = String(row.harness);
      // Claude Code's own cost holds its sub-agents' already
      const counted = harness === 'claude' ? [] : agents;
      const na = Number(row.own_cost_na) > 0 || counted.some((agent) => Number(agent.cost_na) > 0);
      const models = new Set<string>([row, ...agents].flatMap((each) => JSON.parse(String(each.models)) as string[]));
      const [start, end] = [timeOf(row.start_ms), timeOf(row.end_ms)];
      return {
        id,
        title: String(row.title),
        repo: String(row.repo),
        harness,
        host: String(row.host),
        models: [...models].sort(),
        cost: na ? 'n/a' : counted.reduce((sum, agent) => sum + Number(agent.cost), Number(row.own_cost)),
        tokens: agents.reduce((sum, agent) => sum + Number(agent.tokens), Number(row.tokens)),
        durationMs: start === null || end === null ? 'n/a' : end - start,
        subAgents: agents.length,
      } satisfies SessionSummary;
    },
    trace(id) {
      const row = selectSession.get(id);
      const [startMs, endMs] = [timeOf(row?.start_ms ?? null), timeOf(row?.end_ms ?? null)];
      if (!row || startMs === null || endMs === null) return null;
      const rows = selectAgents.all(id);
      const statuses = new Map([row, ...rows].flatMap((each) => statusesOf(each.statuses)));
      const agents = rows.map((agent) => ({
        key: String(agent.key),
        parent: agent.parent === null ? null : String(agent.parent),
        name: String(agent.name),
        startMs: timeOf(agent.start_ms),
        endMs: timeOf(agent.end_ms),
        cost: Number(agent.cost_na) > 0 ? null : Number(agent.cost),
        running: agent.running === null ? null : agent.running === 1,
      }));
      return { startMs, endMs, ...(traceOf(JSON.parse(String(row.lanes)), agents, statuses) as Pick<TraceView, 'lanes' | 'agents'>) };
    },
    meta(key) {
      const row = selectMeta.get(key);
      return row ? String(row.value) : null;
    },
    setMeta(key, value) {
      upsertMeta.run(key, value);
    },
    close() {
      db.close();
    },
  };
}
