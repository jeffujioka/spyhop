// What the tests of the history store share: the store under a home, opened read-only beside the
// worker or the catch-up that writes it, the wait for its catch-ups, and a range tab as the real
// worker answers it from the store.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STORE_FILE } from '../../src/history/store.ts';
import { tabBar, tabBody } from '../../src/live/tabs.ts';
import type { Range, RangeAnswer, RangeTab } from '../../src/protocol.ts';
import { type Mounting, mountOn, until } from './live.ts';
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
