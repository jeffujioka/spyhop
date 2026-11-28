// The history store: the SQLite file under the home that keeps, for good, what a catch-up read
// of the session files: the daily lines of their model calls and, for each file, how far it was
// read and the state of its provider's fold there.
//
// - `files`: one row per session file of an Orca host and harness, with the position the read
//   reached, the size and mtime it saw, the HISTORY_VERSION that wrote its state, and that
//   state as JSON (`encodeState` of src/core/refresh.js); an opencode database is one row, whose
//   lines a catch-up replaces from a day on (`replaceDays`);
// - `lines`: the figures (LINE_FIGURES) of a file's model calls by session, day, repo and model;
// - `meta`: string values by key; `host-keys` set to `machine` once the rows of another Orca host
//   are keyed by the machine it reaches, `machine:<node name>` (src/history/catch-up.ts), not by
//   its ssh alias, `ssh:<alias>`, as HISTORY_VERSION 3 kept them;
// - the view `daily_lines`: the lines summed by day, Orca host, repo, harness and model.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LINE_FIGURES } from '../core/insights.js';
import { decodeState, encodeState } from '../core/refresh.js';
import { LOCAL } from '../fleet.ts';

export const STORE_FILE = '.local/state/spyhop/insights.db';

// The version of the file rows' states: a reader takes a row of another version as unread.
// Raise it with KEPT_VERSION (src/core/refresh.js) when a fold's state changes shape, and alone
// when only the insights a fold keeps for the store change (3: the Trace lanes; 4: another Orca
// host's rows keyed by its machine).
export const HISTORY_VERSION = 4;

export type FileRow = { id: number; host: string; harness: string; path: string; pos: number; size: number; mtimeMs: number; version: number; state: unknown };

// A file's row without its state, which is decoded only for a file that will be read.
export type FileMark = Omit<FileRow, 'state'>;

export type DailyLine = { day: string; host: string; repo: string; harness: string; model: string; figures: Record<string, number> };

// A daily line of one read (`takeLines` of src/core/insights.js).
type LineDelta = { day: string; model: string; figures: Record<string, number> };

// A daily line of one read, with the session and the repo it counts in.
export type SessionLine = LineDelta & { session: string; repo: string };

export type Store = {
  // The row of the file `path` of `harness` on the Orca host `host`, but its state; null when
  // none was saved.
  file(host: string, harness: string, path: string): FileMark | null;
  // The state of the file of id `id`.
  state(id: number): unknown;
  // Saves a read of a file of session `session` in `repo`, in one transaction: its lines added to
  // the file's (which a `restarted` read replaces) and its row. Returns the file's id.
  saveRead(file: Omit<FileRow, 'id'>, read: { session: string; repo: string; lines: LineDelta[]; restarted: boolean }): number;
  // Replaces the lines of the file of id `file` of the day `fromDay` (YYYY-MM-DD) and later with
  // `read.lines`, in one transaction; '' replaces them all.
  replaceDays(file: number, fromDay: string, read: { lines: SessionLine[] }): void;
  // The daily lines of the days `from` to `to` (YYYY-MM-DD, both included).
  dailyLines(from: string, to: string): DailyLine[];
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
    // once: the rows, and the read-through marks, of every Orca host keyed by anything but this
    // computer or a machine, which the next catch-up reads again, once each
    if (db.prepare("SELECT value FROM meta WHERE key = 'host-keys'").get()?.value !== 'machine') {
      const other = `host != '${LOCAL}' AND host NOT LIKE 'machine:%'`;
      db.exec(`
        BEGIN;
        DELETE FROM lines WHERE file IN (SELECT id FROM files WHERE ${other});
        DELETE FROM files WHERE ${other};
        DELETE FROM meta WHERE key LIKE 'read:%' AND key NOT LIKE 'read:${LOCAL}:%' AND key NOT LIKE 'read:machine:%';
        INSERT INTO meta (key, value) VALUES ('host-keys', 'machine') ON CONFLICT (key) DO UPDATE SET value = excluded.value;
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
    saveRead(file, { session, repo, lines, restarted }) {
      db.exec('BEGIN');
      try {
        const { id } = upsertFile.get(file.host, file.harness, file.path, file.pos, file.size, file.mtimeMs, file.version, JSON.stringify(encodeState(file.state)))!;
        if (restarted) deleteLines.run(id);
        for (const { day, model, figures } of lines) upsertLine.run(id, session, day, repo, model, ...LINE_FIGURES.map((name) => figures[name]));
        db.exec('COMMIT');
        return Number(id);
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    replaceDays(file, fromDay, { lines }) {
      db.exec('BEGIN');
      try {
        deleteDays.run(file, fromDay);
        for (const { session, day, repo, model, figures } of lines) upsertLine.run(file, session, day, repo, model, ...LINE_FIGURES.map((name) => figures[name]));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
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
