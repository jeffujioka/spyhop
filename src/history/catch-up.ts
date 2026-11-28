// The catch-up: reads the omp and Claude Code session files of this computer and of every Orca
// host `hosts` lists (each SSH host and paired Orca server, over `ssh <alias>`) into the history
// store (src/history/store.ts), each from where its last read ended, so that the store keeps their
// daily lines for good. A run reads this computer and each other host at once, a host's programs
// one at a time. Another host's system and home folder are asked first (`uname -s`, `printenv
// HOME`); its harness folders lie under that home. A host whose `ssh` exits 255, as when it
// cannot be reached, or whose place cannot be asked, is not read: its read stops there, it is
// named in `notRead` until a later run reads it, and the lines kept of it stay.
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
import { type } from 'node:os';
import { readGit } from '../core/git.js';
import { takeLines } from '../core/insights.js';
import { claudeProvider } from '../core/providers/claude.js';
import { claudeProjectsDir } from '../core/providers/claude-sources.js';
import { ompProvider } from '../core/providers/omp.js';
import { ompSessionsDir } from '../core/providers/omp-sources.js';
import { absoluteFolder, listFolder, mainSessionOf, SUBAGENT_DEPTH } from '../core/providers/session-files.js';
import { scanFile } from '../core/refresh.js';
import type { Run } from '../exec.ts';
import { LOCAL } from '../fleet.ts';
import type { HistoryHost } from '../hosts.ts';
import { HISTORY_VERSION, type Store } from './store.ts';

// The meta key of the number of runs that have ended.
const CATCH_UPS = 'catch-ups';

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

// The Orca host a read is of: its id in the store, the runner bound to it, its system (`uname
// -s`) and home folder, and whether `ssh` has reached it so far.
type Place = { host: string; exec: Run; os: string; home: string; reached: () => boolean };

export type CatchUp = {
  // Runs a catch-up, or gives the one running.
  run(): Promise<void>;
  running(): boolean;
  // When the running run started, else the last one; null before the first.
  startedMs(): number | null;
  // The names of the Orca hosts the last run that ended could not read.
  notRead(): string[];
};

// `run`: the plugin's runner; `log`: the worker's log, which a file that cannot be read is
// written to, left for the next run; `hosts`: the Orca hosts other than this computer.
export function createCatchUp({
  run,
  store,
  home,
  log,
  hosts,
}: {
  run: Run;
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
    const { origin } = await readGit({ exec }, { cwd: folder, on: null });
    return origin ?? folder;
  }

  async function catchUp({ host, exec }: Place, { harness, fold }: Harness, dir: string, file: { path: string; mtimeMs: number; size: number }) {
    const row = store.file(host, harness, file.path);
    const usable = row?.version === HISTORY_VERSION ? row : null;
    if (usable && usable.size === file.size && usable.mtimeMs === file.mtimeMs) return;
    const kept = usable ? (store.state(usable.id) as Kept) : undefined;
    const read = await scanFile(exec, fold, kept ? { state: kept.fold, pos: usable!.pos } : null, file.path, file.size);
    const restarted = read.restarted || !kept;
    const repo = restarted ? await repoOf(exec, read.scan.state?.cwd ?? null) : kept!.repo;
    const lines = read.scan.state ? takeLines(read.scan.state.insights) : [];
    store.saveRead(
      { host, harness, path: file.path, pos: read.scan.pos, size: file.size, mtimeMs: file.mtimeMs, version: HISTORY_VERSION, state: { fold: read.scan.state, repo } },
      { session: `${host}\0${harness}\0${mainSessionOf(file.path, dir)}`, repo, lines, restarted },
    );
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
        listed = await listFolder(place.exec, { dir, os: place.os, depth: harness.depth, path: undefined, strict: true });
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
    return ended;
  }

  // Reads the Orca host `host` over `ssh` to its alias: whether it was read, and whether every
  // listing succeeded.
  async function readRemote({ id, name, alias }: HistoryHost) {
    let reached = true;
    const exec: Run = async (command, args, options) => {
      const result = await run(command, args, { ...options, on: alias });
      if (result.code === 255) reached = false;
      return result;
    };
    try {
      const uname = await exec('uname', ['-s']);
      const printenv = uname.code === 0 ? await exec('printenv', ['HOME']) : null;
      const hostHome = printenv?.code === 0 ? printenv.stdout.trim() : '';
      if (hostHome) {
        const ended = await readHost({ host: id, exec, os: uname.stdout.trim(), home: hostHome, reached: () => reached });
        if (reached) return { name, read: true, ended };
      }
    } catch (error) {
      log(`spyhop: catch-up cannot ask the place of ${name}: ${(error as Error).message}`);
    }
    log(`spyhop: catch-up cannot read ${name}`);
    return { name, read: false, ended: true };
  }

  async function runOnce() {
    const [ended, remotes] = await Promise.all([
      readHost({ host: LOCAL, exec: run, os: type(), home, reached: () => true }),
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
