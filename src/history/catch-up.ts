// The catch-up: reads this computer's omp session files into the history store
// (src/history/store.ts), each from where its last read ended, so that the store keeps their
// daily lines for good. One run lists every `.jsonl` file under omp's sessions folder, down to
// the sub-agents of sub-agents, with one `find`; a listing that fails, but for a sessions folder
// that does not exist, is logged and reads nothing, and the run does not count as ended. A file
// whose size and modified time are those of its last read is not read, any other is advanced by
// `scanFile` (src/core/refresh.js) from the position and the fold state the store keeps for it,
// with omp's fold keeping daily lines.
// Its new lines are saved with that state in one transaction; a file read again from its start
// replaces the lines it gave before. Its programs run one at a time, so a run never holds more
// than one program slot.
//
// A file's lines count in its session, `local\0omp\0<main session file>` (a sub-agent's
// transcript in its main session's), and in its repo: set when the file is read from its start,
// the git origin of the folder its own `session` entry records, else that folder, else `n/a`.
import { type } from 'node:os';
import { readGit } from '../core/git.js';
import { takeLines } from '../core/insights.js';
import { ompProvider } from '../core/providers/omp.js';
import { ompSessionOf, ompSessionsDir } from '../core/providers/omp-sources.js';
import { absoluteFolder, listFolder, SUBAGENT_DEPTH } from '../core/providers/session-files.js';
import { scanFile } from '../core/refresh.js';
import type { Run } from '../exec.ts';
import { LOCAL } from '../fleet.ts';
import { HISTORY_VERSION, type Store } from './store.ts';

// The meta key of the number of runs that have ended.
const CATCH_UPS = 'catch-ups';

// The state a file's row keeps: omp's fold state and the repo its lines count in.
type Kept = { fold: { cwd: string | null; insights: object }; repo: string };

export type CatchUp = {
  // Runs a catch-up, or gives the one running.
  run(): Promise<void>;
  running(): boolean;
  // When the running run started, else the last one; null before the first.
  startedMs(): number | null;
};

const fold = (state: unknown, entries: unknown[]) => ompProvider.fold(state, entries, { insights: true });

// `run`: the plugin's runner; `log`: the worker's log, which a file that cannot be read is
// written to, left for the next run.
export function createCatchUp({ run, store, home, log }: { run: Run; store: Store; home: string; log: (message: string) => void }): CatchUp {
  const dir = ompSessionsDir(home);
  let current: Promise<void> | null = null;
  let started: number | null = null;

  async function repoOf(cwd: string | null) {
    const folder = absoluteFolder(cwd);
    if (!folder) return 'n/a';
    const { origin } = await readGit({ exec: run }, { cwd: folder, on: null });
    return origin ?? folder;
  }

  async function catchUp(file: { path: string; mtimeMs: number; size: number }) {
    const row = store.file(LOCAL, 'omp', file.path);
    const usable = row?.version === HISTORY_VERSION ? row : null;
    if (usable && usable.size === file.size && usable.mtimeMs === file.mtimeMs) return;
    const kept = usable?.state as Kept | undefined;
    const read = await scanFile(run, fold, kept ? { state: kept.fold, pos: usable!.pos } : null, file.path, file.size);
    const restarted = read.restarted || !kept;
    const repo = restarted ? await repoOf(read.scan.state?.cwd ?? null) : kept!.repo;
    const lines = read.scan.state ? takeLines(read.scan.state.insights) : [];
    store.saveRead(
      { host: LOCAL, harness: 'omp', path: file.path, pos: read.scan.pos, size: file.size, mtimeMs: file.mtimeMs, version: HISTORY_VERSION, state: { fold: read.scan.state, repo } },
      { session: `${LOCAL}\0omp\0${ompSessionOf(file.path, dir)}`, repo, lines, restarted },
    );
  }

  async function runOnce() {
    let listed;
    try {
      // `path` named: the JS signature's inferred type asks for it
      listed = await listFolder(run, { dir, os: type(), depth: 2 + SUBAGENT_DEPTH, path: undefined, strict: true });
    } catch (error) {
      log(`spyhop: catch-up cannot list ${dir}: ${(error as Error).message}`);
      return;
    }
    for (const file of listed) {
      if (file.path.endsWith('/changes.jsonl')) continue;
      try {
        await catchUp(file);
      } catch (error) {
        log(`spyhop: catch-up cannot read ${file.path}: ${(error as Error).message}`);
      }
    }
    store.setMeta(CATCH_UPS, String(Number(store.meta(CATCH_UPS) ?? 0) + 1));
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
  };
}
