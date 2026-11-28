// What the tests of the history store share: the store under a home, opened read-only beside the
// worker or the catch-up that writes it, the wait for its catch-ups, and a range tab as the real
// worker answers it from the store.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { run, runBytes } from '../../src/exec.ts';
import { createCatchUp } from '../../src/history/catch-up.ts';
import { openStore, STORE_FILE, type Store } from '../../src/history/store.ts';
import { tabBar, tabBody } from '../../src/live/tabs.ts';
import type { Range, RangeAnswer, RangeTab } from '../../src/protocol.ts';
import { type Mounting, mountOn, until } from './live.ts';
import { setEnv, useTempHome } from './env.ts';
import type { HostWorkspace } from './orca-host.ts';

// The history store of `home`, read-only; the caller closes it.
export const storeOf = (home: string) => new DatabaseSync(join(home, STORE_FILE), { readOnly: true });

// How many catch-ups have ended on the store of `home`: 0 while it has no store, or no meta yet.
function catchUps(home: string) {
  if (!existsSync(join(home, STORE_FILE))) return 0;
  const db = storeOf(home);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'catch-ups'").get();
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

// Resolves once `runs` catch-ups have ended on the store of `home` (see `until`).
export const caughtUp = (home: string, runs = 1) => until(() => catchUps(home) >= runs);

// The worker's answer for the range tab `tab` over `range`, once its first catch-up has read the
// session files `prepare` wrote under the home (test/helpers/live.ts mounts it, with the mock
// clock at `now`), the tab bar and the tab drawn from it, and the stand-ins' calls.
export async function rangeOf(workspaces: HostWorkspace[], { tab, range, ...mounting }: Mounting & { tab: RangeTab; range: Range }) {
  const { home, mounted, calls } = await mountOn(workspaces, mounting);
  await caughtUp(home);
  const answer = (await mounted.request('spyhop.range', { request: 1, tab, range })) as RangeAnswer;
  return { answer, html: tabBar(tab, range) + tabBody(answer), calls };
}

// The store after a catch-up, in UTC, of this computer's home once `write` has filled it with
// sessions, then `more` runs of it, each once `between` has changed the home; the caller closes it.
export async function caughtUpStore(write: (home: string) => void, between: (home: string) => void = () => {}, more = 0): Promise<Store> {
  setEnv('TZ', 'UTC');
  const home = useTempHome();
  write(home);
  const store = await openStore(home);
  const catchUp = createCatchUp({ run, runBytes, store, home, log: () => {}, hosts: async () => [], aliasOf: async () => null });
  await catchUp.run();
  for (let i = 0; i < more; i++) {
    between(home);
    await catchUp.run();
  }
  return store;
}

// The figures of the daily lines of `store` summed over every day, repo and model, of the repos
// whose folder is one of `folders` when given (opencode's fixture database holds sessions of its
// own).
export function sumsOf(opened: Store, folders: string[]) {
  const sums: Record<string, number> = {};
  for (const { repo, figures } of opened.dailyLines('2000-01-01', '2100-01-01')) if (folders.length === 0 || folders.some((folder) => repo.endsWith(`/${folder}`))) for (const [name, value] of Object.entries(figures)) sums[name] = (sums[name] ?? 0) + value;
  return sums;
}

// The figures of `sums` named `names` that are not 0.
export const nonZero = (sums: Record<string, number>, ...names: string[]) => Object.fromEntries(names.filter((name) => sums[name] !== 0).map((name) => [name, sums[name]]));
