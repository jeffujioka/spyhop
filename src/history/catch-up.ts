// The catch-up: reads the omp and Claude Code session files and the opencode database (see below)
// of this computer and of every Orca host `hosts` lists (each SSH host and paired Orca server,
// over `ssh <alias>`) into the history store (src/history/store.ts), each from where its last
// read ended, so that the store keeps their daily lines for good. A run reads this computer and
// each other host at once, a host's programs one at a time. Another host's system and home folder
// are asked first (`uname -s`, `printenv HOME`); its harness folders lie under that home. A host
// whose `ssh` exits 255, as when it cannot be reached, or whose place cannot be asked, is not
// read: its read stops there, it is named in `notRead` until a later run reads it, and the lines
// kept of it stay. Then `zstd -V` is asked once: on a host where it exits 0, the listings
// (`find`), the reads of a file's bytes (`dd`, `tail`) and opencode's queries (`sqlite3`) run
// within ZSTD_SCRIPT, their output decompressed here and their exit code their own; on any
// other, they run raw. `uname`, `printenv` and `git` always run raw.
//
// On each host, one run lists every `.jsonl` file under each harness's sessions folder, down to
// the sub-agents (of sub-agents, for omp), with one `find` each; a listing that fails, but for a
// sessions folder that does not exist, is logged and reads nothing of that harness, and the run
// does not count as ended. A file whose size and modified time are those of its last read is not
// read, any other is advanced by `scanFile` (src/core/refresh.js) from the position and the fold
// state the store keeps for it, with its harness's fold keeping daily lines. Its new lines are
// saved with that state in one transaction; a file read again from its start replaces the lines
// it gave before.
//
// A file's lines count in its host's lines (`local` for this computer, else the Orca hostId), in
// its session, `<host>\0<harness>\0<main session file>` (a sub-agent's transcript in its main
// session's), and in its repo: set when the file is read from its start, the git origin, on its
// host, of the folder the file itself records first (omp: its `session` entry), else that
// folder, else `n/a`.
//
// On each host, the run then reads opencode's database (`databaseOf`, src/core/providers/
// opencode-sources.js), a `files` row of its own, with `sqlite3 -readonly`; a host without one,
// or without sqlite3, has none to read. Its first read pages every model call, by the time it
// was created, PAGE_ROWS at a time; each later run replaces the database's lines of the day
// OPENCODE_OPEN_DAYS before today and after, from the calls created since that day's start, since
// opencode updates a call in place: an older day stays as it was read. A call counts on the day
// it was created, in its root session (its `parent_id` followed up), `<host>\0opencode\0<root
// session id>`, and in the repo of its own session's folder, the git origin as above.
import { type } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { dayOf } from '../core/days.js';
import { readOrigin } from '../core/git.js';
import { newInsights, takeLines } from '../core/insights.js';
import { claudeProvider } from '../core/providers/claude.js';
import { claudeProjectsDir } from '../core/providers/claude-sources.js';
import { opencodeInsights } from '../core/providers/opencode.js';
import { databaseOf, historyRowsQuery, SCHEMA_QUERY, select, sessionsIn } from '../core/providers/opencode-sources.js';
import { ompProvider } from '../core/providers/omp.js';
import { ompSessionsDir } from '../core/providers/omp-sources.js';
import { absoluteFolder, listFolder, mainSessionOf, SUBAGENT_DEPTH } from '../core/providers/session-files.js';
import { scanFile } from '../core/refresh.js';
import type { Run, RunBytes } from '../exec.ts';
import { LOCAL } from '../fleet.ts';
import { type HistoryHost, placeOf } from '../hosts.ts';
import { HISTORY_VERSION, type SessionLine, type Store } from './store.ts';

// The meta key of the number of runs that have ended.
const CATCH_UPS = 'catch-ups';

// How many days of opencode's calls each catch-up reads again, today's not counted, and how
// many of its rows one query reads.
export const OPENCODE_OPEN_DAYS = 10;
const PAGE_ROWS = 5000;

// The script, run as `sh -c <script> sh <program> <args…>`, that prints the program's output
// compressed by `zstd` and exits with the program's exit code: the code goes out of the pipe on
// fd 3, while the compressed output goes to the script's stdout, kept on fd 4.
const ZSTD_SCRIPT = 'exec 4>&1; s=$( { { "$@"; echo $? >&3; } | zstd -q -c >&4; } 3>&1 ); exit $s';

// The state a file's row keeps: its harness's fold state and the repo its lines count in.
type Kept = { fold: { cwd: string | null; insights: object }; repo: string };

// Each harness the catch-up reads: its name in the store, its sessions folder under a home, how
// many folders deep its files lie, its sub-agents' included, and its fold with daily lines.
// Claude Code keeps a sub-agent's transcript in `<folder>/<session>/subagents/`.
const HARNESSES = [
  {
    harness: 'omp',
    dirOf: ompSessionsDir,
    depth: 2 + SUBAGENT_DEPTH,
    fold: (state: unknown, entries: unknown[]) => ompProvider.fold(state, entries, { insights: true }),
  },
  {
    harness: 'claude',
    dirOf: claudeProjectsDir,
    depth: 4,
    fold: (state: unknown, entries: unknown[]) => claudeProvider.fold(state, entries, { insights: true }),
  },
];

type Harness = (typeof HARNESSES)[number];

// The Orca host a read is of: its id in the store, the runner bound to it and the one that lists
// its files and reads their bytes, its system (`uname -s`) and home folder, and whether `ssh` has
// reached it so far.
type Place = { host: string; exec: Run; read: Run; os: string; home: string; reached: () => boolean };

export type CatchUp = {
  // Runs a catch-up, or gives the one running.
  run(): Promise<void>;
  running(): boolean;
  // When the running run started, else the last one; null before the first.
  startedMs(): number | null;
  // The names of the Orca hosts the last run that ended could not read.
  notRead(): string[];
};

// `run` and `runBytes`: the plugin's runners; `log`: the worker's log, which a file that cannot
// be read is written to, left for the next run; `hosts`: the Orca hosts other than this computer.
export function createCatchUp({
  run,
  runBytes,
  store,
  home,
  log,
  hosts,
}: {
  run: Run;
  runBytes: RunBytes;
  store: Store;
  home: string;
  log: (message: string) => void;
  hosts: () => Promise<HistoryHost[]>;
}): CatchUp {
  let current: Promise<void> | null = null;
  let started: number | null = null;
  let unread: string[] = [];

  async function repoOf(exec: Run, cwd: string | null) {
    const folder = absoluteFolder(cwd);
    if (!folder) return 'n/a';
    return (await readOrigin({ exec }, { cwd: folder, on: null })) ?? folder;
  }

  // A read is saved only while its host has been reached, so that a repo asked over a dropped
  // connection (its origin none) is never kept for good.
  async function catchUp(place: Place, { harness, fold }: Harness, dir: string, file: { path: string; mtimeMs: number; size: number }) {
    const { host, exec } = place;
    const row = store.file(host, harness, file.path);
    const usable = row?.version === HISTORY_VERSION ? row : null;
    if (usable && usable.size === file.size && usable.mtimeMs === file.mtimeMs) return;
    const kept = usable ? (store.state(usable.id) as Kept) : undefined;
    const read = await scanFile(place.read, fold, kept ? { state: kept.fold, pos: usable!.pos } : null, file.path, file.size);
    const restarted = read.restarted || !kept;
    const repo = restarted ? await repoOf(exec, read.scan.state?.cwd ?? null) : kept!.repo;
    if (!place.reached()) throw new Error(`lost ${host} while reading ${file.path}`);
    const lines = read.scan.state ? takeLines(read.scan.state.insights) : [];
    store.saveRead(
      { host, harness, path: file.path, pos: read.scan.pos, size: file.size, mtimeMs: file.mtimeMs, version: HISTORY_VERSION, state: { fold: read.scan.state, repo } },
      { session: `${host}\0${harness}\0${mainSessionOf(file.path, dir)}`, repo, lines, restarted },
    );
  }

  // Reads the opencode database of the host of `place` (see the header): its lines of the days
  // it reads again replaced with those read now, once they are all read and the host was reached.
  async function readOpencode(place: Place) {
    const { host, read } = place;
    const database = databaseOf(place.home);
    const tables = await select(read, database, SCHEMA_QUERY);
    const sessions = tables && sessionsIn(tables);
    if (!sessions) return;
    const row = store.file(host, 'opencode', database);
    const first = row?.version !== HISTORY_VERSION;
    const today = new Date();
    const open = new Date(today.getFullYear(), today.getMonth(), today.getDate() - OPENCODE_OPEN_DAYS).getTime();
    // by root session and the folder of the row's own session
    const groups = new Map<string, { session: string; directory: string | null; insights: object }>();
    let from = first ? 0 : open;
    let after: string | null = null;
    for (;;) {
      const rows = await select(read, database, historyRowsQuery(sessions, from, after, PAGE_ROWS));
      if (!rows) throw new Error(`cannot read the model calls of ${database}`);
      for (const call of rows) {
        const key = `${call.sessionId}\0${call.directory}`;
        let group = groups.get(key);
        if (!group) groups.set(key, (group = { session: String(call.sessionId), directory: call.directory ?? null, insights: newInsights() }));
        opencodeInsights([call], group.insights);
      }
      if (rows.length < PAGE_ROWS) break;
      ({ created: from, id: after } = rows.at(-1));
    }
    const repos = new Map<string | null, string>();
    const lines: SessionLine[] = [];
    for (const { session, directory, insights } of groups.values()) {
      if (!repos.has(directory)) repos.set(directory, await repoOf(place.exec, directory));
      const repo = repos.get(directory)!;
      for (const line of takeLines(insights)) lines.push({ ...line, session: `${host}\0opencode\0${session}`, repo });
    }
    if (!place.reached()) throw new Error(`lost ${host} while reading ${database}`);
    // the row is marked read whole (HISTORY_VERSION) only once its lines are saved
    const file = (version: number) => ({ host, harness: 'opencode', path: database, pos: 0, size: 0, mtimeMs: 0, version, state: null });
    const none = { session: '', repo: '', lines: [], restarted: false };
    const id = row?.id ?? store.saveRead(file(0), none);
    store.replaceDays(id, first ? '' : dayOf(open), { lines });
    if (first) store.saveRead(file(HISTORY_VERSION), none);
  }

  // Reads the session files of the host of `place`, one program at a time, until `ssh` fails to
  // reach it; whether every listing succeeded.
  async function readHost(place: Place) {
    let ended = true;
    for (const harness of HARNESSES) {
      const dir = harness.dirOf(place.home);
      let listed;
      try {
        // `path` named: the JS signature's inferred type asks for it
        listed = await listFolder(place.read, { dir, os: place.os, depth: harness.depth, path: undefined, strict: true });
      } catch (error) {
        if (!place.reached()) return ended;
        log(`spyhop: catch-up cannot list ${dir}: ${(error as Error).message}`);
        ended = false;
        continue;
      }
      for (const file of listed) {
        // omp's edit log, no transcript
        if (file.path.endsWith('/changes.jsonl')) continue;
        try {
          await catchUp(place, harness, dir, file);
        } catch (error) {
          if (!place.reached()) return ended;
          log(`spyhop: catch-up cannot read ${file.path}: ${(error as Error).message}`);
        }
      }
    }
    try {
      await readOpencode(place);
    } catch (error) {
      if (!place.reached()) return ended;
      log(`spyhop: catch-up cannot read opencode's database: ${(error as Error).message}`);
    }
    return ended;
  }

  // Reads the Orca host `host` over `ssh` to its alias, from its place (`placeOf`): whether it
  // was read, and whether every listing succeeded.
  async function readRemote({ id, name, alias }: HistoryHost) {
    let reached = true;
    const noted = <Result extends { code: number }>(result: Result) => {
      if (result.code === 255) reached = false;
      return result;
    };
    const exec: Run = async (command, args, options) => noted(await run(command, args, { ...options, on: alias }));
    // the program's own exit code kept; `dd` still prints its statistics on stderr
    const compressed: Run = async (command, args, options) => {
      const { code, stdout, stderr } = noted(await runBytes('sh', ['-c', ZSTD_SCRIPT, 'sh', command, ...args], { ...options, on: alias }));
      // nothing at all when ssh fails
      return { code, stdout: stdout.length === 0 ? '' : zstdDecompressSync(stdout).toString('utf8'), stderr };
    };
    // its programs one after the other, as every program of a host's read
    let place: { os: string; home: string } | null = null;
    try {
      const uname = await exec('uname', ['-s']);
      place = placeOf(uname, uname.code === 0 ? await exec('printenv', ['HOME']) : null, null);
    } catch (error) {
      log(`spyhop: catch-up cannot ask the place of ${name}: ${(error as Error).message}`);
    }
    if (place) {
      // a `zstd -V` that fails, or cannot be run, reads the host raw
      const zstd = await exec('zstd', ['-V']).catch(() => null);
      const ended = reached && (await readHost({ host: id, exec, read: zstd?.code === 0 ? compressed : exec, ...place, reached: () => reached }));
      if (reached) return { name, read: true, ended };
      log(`spyhop: catch-up cannot reach ${name}`);
    }
    return { name, read: false, ended: true };
  }

  async function runOnce() {
    const [ended, remotes] = await Promise.all([
      readHost({ host: LOCAL, exec: run, read: run, os: type(), home, reached: () => true }),
      hosts().then((listed) => Promise.all(listed.map(readRemote))),
    ]);
    unread = remotes.filter(({ read }) => !read).map(({ name }) => name);
    if (ended && remotes.every((remote) => remote.ended)) store.setMeta(CATCH_UPS, String(Number(store.meta(CATCH_UPS) ?? 0) + 1));
  }

  return {
    run() {
      if (!current) {
        started = Date.now();
        current = runOnce().finally(() => {
          current = null;
        });
      }
      return current;
    },
    running: () => current !== null,
    startedMs: () => started,
    notRead: () => unread,
  };
}
