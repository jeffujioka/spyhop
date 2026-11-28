// What the tests of the history store share: the store under a home, opened read-only beside the
// worker or the catch-up that writes it, and the wait for its catch-ups.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STORE_FILE } from '../../src/history/store.ts';
import { until } from './live.ts';

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
