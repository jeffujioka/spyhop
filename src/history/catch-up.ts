// The catch-up: reads the omp and Claude Code session files and the opencode database (see below)
// of this computer and of every Orca host `hosts` lists (each SSH host and paired Orca server,
// over `ssh <alias>`) into the history store (src/history/store.ts), each from where its last
// read ended, so that the store keeps their daily lines for good. A run reads in two phases:
// first the files and opencode calls of the last FIRST_DAYS days, changed or created from that
// day's start on, then the older ones, each phase's files newest first. Within a phase it reads
// this computer and each other host at once, a host's programs one at a time; the second phase
// starts once every host has ended the first. Every other host's system, node name and home
// folder are asked first (`uname -sn`, `printenv HOME`), before any is read; its harness folders
// lie under that home. Hosts whose node name and home are the same reach one machine, read once,
// over the first of them in Orca's order; one whose node name (lowercased) and home are this
// computer's (`hostname()`) reaches this computer, read here, so it is not read nor named. A host
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
// While a run reads, `progress` names the first host (this computer, then Orca's order) and
// harness it is still reading that has never been read through (the meta `read:<host>:<harness>`
// unset, set once a run has read it through), with the share of its bytes read: of the bytes left
// to read of its listed files (each file's size less the position its last read ended at), those
// of the files read, 99% at most until it ends; of opencode's, the rows read of those the run
// reads, counted only while the database was never read through, and unknown, so never named,
// when that count fails.
//
// A file's lines count in its host's lines (`local` for this computer, else `machine:<the node
// name of the machine its host reaches>`, so a target Orca lists again under a new id or a new
// alias counts once), in
// its session, `<host>\0<harness>\0<main session file>` (a sub-agent's transcript in its main
// session's), and in its repo: set when the file is read from its start, the git origin, on its
// host, of the folder the file itself records first (omp: its `session` entry), else that
// folder, else `n/a`.
//
// On each host, the run then reads opencode's database (`databaseOf`, src/core/providers/
// opencode-sources.js), a `files` row of its own, with `sqlite3 -readonly`; a host without one
// has none to read, and one there that cannot be read (`stat` finds it) is logged. Its first read
// pages every model call, by the time it was created, PAGE_ROWS at a time, those of the first
// phase's days in the first phase, saved then, the older ones in the second, when its lines are
// replaced with both phases' and it is marked read whole; each later run replaces, in the first
// phase, the database's lines of the day OPENCODE_OPEN_DAYS before today and after, from the
// calls created since that day's start, since opencode updates a call in place: an older day
// stays as it was read. opencode indexes no message by its time, so each page scans and sorts
// the messages, and rebuilds the session tree, on the host: a first read of a large database
// costs that once per page. A call counts on the day it was created, in its root session (its
// `parent_id` followed up), `<host>\0opencode\0<root session id>`, and in the repo of its own
// session's folder: the git origin as above, asked when a read first meets the folder and kept,
// by folder, in the row's state.
import { hostname, type } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { HARNESS_NAMES } from '../agent-cards.ts';
import { dayOf, midnightBefore } from '../core/days.js';
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
import { newestFirst } from '../core/session-link.js';
import { MAX_OUTPUT_BYTES, type Run, type RunBytes } from '../exec.ts';
import { LOCAL } from '../fleet.ts';
import { type HistoryHost, placeOf } from '../hosts.ts';
import type { ReadProgress } from '../protocol.ts';
import { type FileMark, HISTORY_VERSION, type SessionLine, type Store } from './store.ts';

// The meta key of the number of runs that have ended.
const CATCH_UPS = 'catch-ups';

// How many days the first phase of a run reads, today's not counted.
export const FIRST_DAYS = 30;

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

// The state an opencode database's row keeps: the repo of each folder its calls are of (a
// session without a folder is under null).
type OpencodeKept = { repos: Map<string | null, string> };

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

// The Orca host a read is of: its id in the store and its name, its place in the order
// `progress` names hosts in (this computer 0, then Orca's order), the runner bound to it and the
// one that lists its files and reads their bytes, its system (`uname -s`) and home folder, and
// whether `ssh` has reached it so far.
type Place = { host: string; name: string; rank: number; exec: Run; read: Run; os: string; home: string; reached: () => boolean };

// A session file a run lists: its harness and sessions folder, the row of its last read when it
// is of this version, and the bytes left to read of it.
type Listed = { path: string; mtimeMs: number; size: number; harness: Harness; dir: string; row: FileMark | null; toRead: number };

// What the first phase of a first read of an opencode database leaves to the second: the
// database, its sessions (`sessionsIn`), its row's id, the repo of each folder and the lines it
// saved.
type OpencodeLeft = { database: string; sessions: string; id: number; repos: Map<string | null, string>; lines: SessionLine[] };

// What the first phase of a host's read leaves to the second: its place, whether every listing
// succeeded, the harnesses listed, the files listed and what is left of its opencode database.
type HostRead = { place: Place; ended: boolean; harnesses: string[]; files: Listed[]; opencode: OpencodeLeft | null };

// What the running run has read of a host's harness: its bytes (opencode: its rows) to read, and
// read.
type Share = { host: string; name: string; rank: number; harness: string; toRead: number; read: number };

export type CatchUp = {
  // Runs a catch-up, or gives the one running.
  run(): Promise<void>;
  running(): boolean;
  // When the running run started, else the last one; null before the first.
  startedMs(): number | null;
  // The names of the Orca hosts the last run that ended could not read.
  notRead(): string[];
  // The host and harness the running run is reading that were never read through, and the share
  // of it read (see the header); null when there is none, or no run is running.
  progress(): ReadProgress | null;
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
  let shares: Share[] = [];

  // The meta key set once a run has read the harness `harness` of the Orca host `host` through.
  const readThrough = (host: string, harness: string) => `read:${host}:${harness}`;

  // The share of the harness `harness` of the host of `place` in the running run.
  function shareOf({ host, name, rank }: Place, harness: string) {
    let share = shares.find((found) => found.host === host && found.harness === harness);
    if (!share) shares.push((share = { host, name, rank, harness, toRead: 0, read: 0 }));
    return share;
  }

  async function repoOf(exec: Run, cwd: string | null) {
    const folder = absoluteFolder(cwd);
    if (!folder) return 'n/a';
    return (await readOrigin({ exec }, { cwd: folder, on: null })) ?? folder;
  }

  // A read is saved only while its host has been reached, so that a repo asked over a dropped
  // connection (its origin none) is never kept for good.
  async function catchUp(place: Place, { harness: { harness, fold }, dir, row, path, size, mtimeMs }: Listed) {
    const { host, exec } = place;
    const kept = row ? (store.state(row.id) as Kept) : undefined;
    const read = await scanFile(place.read, fold, kept ? { state: kept.fold, pos: row!.pos } : null, path, size);
    const restarted = read.restarted || !kept;
    const repo = restarted ? await repoOf(exec, read.scan.state?.cwd ?? null) : kept!.repo;
    if (!place.reached()) throw new Error(`lost ${host} while reading ${path}`);
    const lines = read.scan.state ? takeLines(read.scan.state.insights) : [];
    store.saveRead(
      { host, harness, path, pos: read.scan.pos, size, mtimeMs, version: HISTORY_VERSION, state: { fold: read.scan.state, repo } },
      { session: `${host}\0${harness}\0${mainSessionOf(path, dir)}`, repo, lines, restarted },
    );
  }

  // Lists the session files of the host of `place`, one harness after the other: each file but
  // one unchanged since its last read, its bytes left to read counted in its harness's share; null
  // once `ssh` fails to reach the host.
  async function listHost(place: Place): Promise<HostRead | null> {
    const read: HostRead = { place, ended: true, harnesses: [], files: [], opencode: null };
    for (const harness of HARNESSES) {
      const dir = harness.dirOf(place.home);
      let listed;
      try {
        // `path` named: the JS signature's inferred type asks for it
        listed = await listFolder(place.read, { dir, os: place.os, depth: harness.depth, path: undefined, strict: true });
      } catch (error) {
        if (!place.reached()) return null;
        log(`spyhop: catch-up cannot list ${dir}: ${(error as Error).message}`);
        read.ended = false;
        continue;
      }
      read.harnesses.push(harness.harness);
      const share = shareOf(place, harness.harness);
      for (const file of listed) {
        // omp's edit log, no transcript
        if (file.path.endsWith('/changes.jsonl')) continue;
        const found = store.file(place.host, harness.harness, file.path);
        const row = found?.version === HISTORY_VERSION ? found : null;
        if (row && row.size === file.size && row.mtimeMs === file.mtimeMs) continue;
        // a file smaller than read is read again from its start (`scanFile`)
        const toRead = row && file.size >= row.pos ? file.size - row.pos : file.size;
        share.toRead += toRead;
        read.files.push({ ...file, harness, dir, row, toRead });
      }
    }
    return read;
  }

  // Reads `files` of the host of `place`, newest first: a file's bytes left to read count as read
  // in its harness's share once it is read, and as no longer to read when it cannot be. Whether
  // `ssh` still reaches the host.
  async function readFiles(place: Place, files: Listed[]) {
    for (const file of newestFirst(files) as Listed[]) {
      const share = shareOf(place, file.harness.harness);
      try {
        await catchUp(place, file);
        share.read += file.toRead;
      } catch (error) {
        if (!place.reached()) return false;
        log(`spyhop: catch-up cannot read ${file.path}: ${(error as Error).message}`);
        share.toRead -= file.toRead;
      }
    }
    return true;
  }

  // Saves the row of the opencode database `database` of `host`, with `repos`, as of `version`
  // (HISTORY_VERSION: read whole); its id.
  const saveOpencode = (host: string, database: string, repos: Map<string | null, string>, version: number) =>
    store.saveRead(
      { host, harness: 'opencode', path: database, pos: 0, size: 0, mtimeMs: 0, version, state: { repos } satisfies OpencodeKept },
      { session: '', repo: '', lines: [], restarted: false },
    );

  // The lines of the model calls of `sessions` in `database` on the host of `place` created from
  // `fromMs` on and before `untilMs`, by root session and the folder of the call's own session,
  // each in the repo `repos` has of its folder, else asked and added to it; each call read counted
  // in opencode's share.
  async function opencodeLines(place: Place, database: string, sessions: string, fromMs: number, untilMs: number, repos: Map<string | null, string>) {
    const share = shareOf(place, 'opencode');
    // by root session and the folder of the row's own session
    const groups = new Map<string, { session: string; directory: string | null; insights: object }>();
    let from = fromMs;
    let after: string | null = null;
    for (;;) {
      const rows = await select(place.read, database, historyRowsQuery(sessions, from, after, PAGE_ROWS));
      if (!rows) throw new Error(`cannot read the model calls of ${database}`);
      const before = rows.filter((call) => call.created < untilMs);
      for (const call of before) {
        const key = `${call.sessionId}\0${call.directory}`;
        let group = groups.get(key);
        if (!group) groups.set(key, (group = { session: String(call.sessionId), directory: call.directory ?? null, insights: newInsights() }));
        opencodeInsights([call], group.insights);
      }
      share.read += before.length;
      if (rows.length < PAGE_ROWS || before.length < rows.length) break;
      ({ created: from, id: after } = rows.at(-1));
    }
    const lines: SessionLine[] = [];
    for (const { session, directory, insights } of groups.values()) {
      if (!repos.has(directory)) repos.set(directory, await repoOf(place.exec, directory));
      const repo = repos.get(directory)!;
      for (const line of takeLines(insights)) lines.push({ ...line, session: `${place.host}\0opencode\0${session}`, repo });
    }
    return lines;
  }

  // The first phase of the read of the opencode database of the host of `place` (see the header),
  // whose first read reads the calls created from `recentMs` on: the lines of the days it reads
  // replaced with those read now, once they are all read and the host was reached. What a first
  // read leaves to the second phase; null otherwise.
  async function readOpencode(place: Place, recentMs: number): Promise<OpencodeLeft | null> {
    const { host, read } = place;
    const database = databaseOf(place.home);
    const tables = await select(read, database, SCHEMA_QUERY);
    if (!tables) {
      // a missing database is no failure
      if ((await place.exec('stat', [database])).code === 0) throw new Error(`cannot read ${database}`);
      return null;
    }
    const sessions = sessionsIn(tables);
    if (!sessions) return null;
    const row = store.file(host, 'opencode', database);
    const first = row?.version !== HISTORY_VERSION;
    const open = midnightBefore(Date.now(), OPENCODE_OPEN_DAYS);
    // the calls of both phases, for `progress` only: counted until the database is read through,
    // a count that fails leaving its share unknown, never shown
    if (store.meta(readThrough(host, 'opencode')) === null) {
      const counted = await select(read, database, `SELECT count(*) AS n FROM (${historyRowsQuery(sessions, first ? 0 : open, null, -1)})`);
      if (counted) shareOf(place, 'opencode').toRead += Number(counted[0]?.n ?? 0);
    }
    // each folder's repo as first asked
    const repos = first ? new Map<string | null, string>() : (store.state(row!.id) as OpencodeKept).repos;
    const lines = await opencodeLines(place, database, sessions, first ? recentMs : open, Infinity, repos);
    if (!place.reached()) throw new Error(`lost ${host} while reading ${database}`);
    const id = row?.id ?? saveOpencode(host, database, repos, 0);
    store.replaceDays(id, first ? '' : dayOf(open), { lines });
    if (first) return { database, sessions, id, repos, lines };
    saveOpencode(host, database, repos, HISTORY_VERSION);
    store.setMeta(readThrough(host, 'opencode'), '1');
    return null;
  }

  // The second phase of a first read of an opencode database: its calls created before
  // `recentMs`, whose lines with the first phase's replace all its lines, its row then marked read
  // whole (HISTORY_VERSION), with its repos, once the host was reached.
  async function readOlderOpencode(place: Place, { database, sessions, id, repos, lines }: OpencodeLeft, recentMs: number) {
    const older = await opencodeLines(place, database, sessions, 0, recentMs, repos);
    if (!place.reached()) throw new Error(`lost ${place.host} while reading ${database}`);
    store.replaceDays(id, '', { lines: [...older, ...lines] });
    saveOpencode(place.host, database, repos, HISTORY_VERSION);
    store.setMeta(readThrough(place.host, 'opencode'), '1');
  }

  // The first phase of the read of the host of `place`: its session files listed, and those
  // changed from `recentMs` on and the first phase of its opencode database read; null once `ssh`
  // fails to reach it.
  async function phaseOne(place: Place, recentMs: number) {
    if (!place.reached()) return null;
    const read = await listHost(place);
    if (!read || !(await readFiles(place, read.files.filter((file) => file.mtimeMs >= recentMs)))) return null;
    try {
      read.opencode = await readOpencode(place, recentMs);
    } catch (error) {
      if (!place.reached()) return null;
      log(`spyhop: catch-up cannot read opencode's database ${databaseOf(place.home)}: ${(error as Error).message}`);
    }
    return read;
  }

  // The second phase: the rest of the host's files read, each harness it listed then read
  // through, and the rest of its opencode database; whether `ssh` still reaches the host.
  async function phaseTwo({ place, harnesses, files, opencode }: HostRead, recentMs: number) {
    if (!(await readFiles(place, files.filter((file) => file.mtimeMs < recentMs)))) return false;
    for (const harness of harnesses) store.setMeta(readThrough(place.host, harness), '1');
    if (!opencode) return true;
    try {
      await readOlderOpencode(place, opencode, recentMs);
    } catch (error) {
      if (!place.reached()) return false;
      log(`spyhop: catch-up cannot read opencode's database ${opencode.database}: ${(error as Error).message}`);
    }
    return true;
  }

  // The Orca host `host` over `ssh` to its alias: the node name and home of the machine it reaches
  // (`placeOf` of `uname -sn` and `printenv HOME`), and its place, `rank` in `progress`'s order,
  // keyed by that machine, `machine:<node name>`, with `zstd -V` asked; null when its place cannot
  // be asked.
  async function probe({ name, alias }: HistoryHost, rank: number) {
    let reached = true;
    const noted = <Result extends { code: number }>(result: Result) => {
      if (result.code === 255) reached = false;
      return result;
    };
    const exec: Run = async (command, args, options) => noted(await run(command, args, { ...options, on: alias }));
    // the program's own exit code kept; `dd` still prints its statistics on stderr; its output
    // decompressed no larger than a raw answer may be, past which it rejects as a raw one does
    const compressed: Run = async (command, args, options) => {
      const { code, stdout, stderr } = noted(await runBytes('sh', ['-c', ZSTD_SCRIPT, 'sh', command, ...args], { ...options, on: alias }));
      // nothing at all when ssh fails
      return { code, stdout: stdout.length === 0 ? '' : zstdDecompressSync(stdout, { maxOutputLength: MAX_OUTPUT_BYTES }).toString('utf8'), stderr };
    };
    // its programs one after the other, as every program of a host's read
    let found: { os: string; node: string; home: string };
    try {
      const uname = await exec('uname', ['-sn']);
      found = placeOf(uname, uname.code === 0 ? await exec('printenv', ['HOME']) : null, null);
    } catch (error) {
      log(`spyhop: catch-up cannot ask the place of ${name}: ${(error as Error).message}`);
      return null;
    }
    const { os, node, home: at } = found;
    return {
      machine: `${node}\0${at}`,
      async place(): Promise<Place> {
        // a `zstd -V` that fails, or cannot be run, reads the host raw
        const zstd = await exec('zstd', ['-V']).catch(() => null);
        return { host: `machine:${node}`, name, rank, exec, read: zstd?.code === 0 ? compressed : exec, os, home: at, reached: () => reached };
      },
    };
  }

  async function runOnce() {
    shares = [];
    const recent = midnightBefore(Date.now(), FIRST_DAYS);
    const local: Place = { host: LOCAL, name: LOCAL, rank: 0, exec: run, read: run, os: type(), home, reached: () => true };
    // the first phase on every host at once, every other host's machine asked first: a machine is
    // read once, over its first alias in Orca's order, and this computer, read here, never over
    // ssh; a host whose machine cannot be asked is not read
    const [localRead, remotes] = await Promise.all([
      phaseOne(local, recent),
      hosts().then(async (listed) => {
        const probed = await Promise.all(listed.map((host, i) => probe(host, i + 1)));
        const machines = new Set([`${hostname().toLowerCase()}\0${home}`]);
        const kept = listed.flatMap((host, i) => {
          const machine = probed[i]?.machine;
          if (machine !== undefined && machines.has(machine)) return [];
          if (machine !== undefined) machines.add(machine);
          return [{ name: host.name, probed: probed[i] }];
        });
        return Promise.all(
          kept.map(async ({ name, probed: found }) => {
            const place = found && (await found.place());
            return { name, place, read: place && (await phaseOne(place, recent)) };
          }),
        );
      }),
    ]);
    // the second phase on every host the first one read, at once
    const reads = [localRead, ...remotes.map(({ read }) => read)];
    const done = await Promise.all(reads.map((read) => read !== null && phaseTwo(read, recent)));
    unread = [];
    remotes.forEach(({ name, place }, i) => {
      if (done[i + 1]) return;
      if (place) log(`spyhop: catch-up cannot reach ${name}`);
      unread.push(name);
    });
    if (reads.every((read, i) => !done[i] || read!.ended)) store.setMeta(CATCH_UPS, String(Number(store.meta(CATCH_UPS) ?? 0) + 1));
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
    progress() {
      if (!current) return null;
      // stable: a host's harnesses in the order they were read
      const [reading] = shares
        .filter((share) => share.read < share.toRead && store.meta(readThrough(share.host, share.harness)) === null)
        .sort((a, b) => a.rank - b.rank);
      // 99% at most while it reads, the rounded percent never 100% before it ends
      return reading ? { host: reading.name, harness: HARNESS_NAMES[reading.harness] ?? reading.harness, share: Math.min(reading.read / reading.toRead, 0.99) } : null;
    },
  };
}
