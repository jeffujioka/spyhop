// The plugin's status bar item: Orca keeps a worker with a status bar item running while the
// plugin is enabled, so the 15-minute catch-ups go on with the panel closed. The worker sets the
// item's text to today's spend on every Orca host, from the history store, at activation and
// after each catch-up. The worker is the real one, mounted on this computer's Orca host as the test
// kit plays it (test/helpers/live.ts), whose `statusBar.update` calls the test reads.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mock, test } from 'node:test';
import { RANGE_REFRESH_MS } from '../src/core/refresh.js';
import { STORE_FILE } from '../src/history/store.ts';
import { NOW } from './helpers/agent-cards.ts';
import { caughtUp } from './helpers/history.ts';
import { mountOn, ompSession, spent, until } from './helpers/live.ts';

// The text and the tooltip of the worker's last update of the item `spyhop`, if any.
function shown(updates: unknown[]) {
  const last = updates.at(-1) as { id: string; text: string; tooltip: string } | undefined;
  assert.equal(last?.id ?? 'spyhop', 'spyhop');
  return last && { text: last.text, tooltip: last.tooltip };
}

test("the status bar item follows today's spend after a catch-up", async () => {
  const first = spent(1);
  const { home, mounted } = await mountOn([], { prepare: (at) => ompSession(at, join(at, 'api'), { title: 'api', calls: [first] }) });
  const updates = () => mounted.host.callsOf('statusBar.update');
  await caughtUp(home);
  // set at activation, before the first catch-up ended, from the empty store
  assert.partialDeepStrictEqual(updates()[0], { id: 'spyhop', text: '$0.00 today' });
  await until(() => shown(updates())?.text === '$1.00 today');
  assert.equal(shown(updates())!.tooltip, "Spyhop: today's model spend on every Orca host");

  // a call of 0.25 USD logged since; a range ask a range refresh later runs a catch-up
  ompSession(home, join(home, 'api'), { title: 'api', calls: [first, spent(0.25, NOW)] });
  mock.timers.tick(RANGE_REFRESH_MS);
  await mounted.request('spyhop.range', { request: 1, tab: 'spend', range: 'day' });
  await caughtUp(home, 2);

  await until(() => shown(updates())?.text === '$1.25 today');
});

test('the status bar item is n/a when the history store cannot be opened', async () => {
  const { mounted } = await mountOn([], {
    prepare: (home) => {
      const path = join(home, STORE_FILE);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'not a SQLite file, but long enough for SQLite to read its header as one');
    },
  });

  await until(() => shown(mounted.host.callsOf('statusBar.update'))?.text === 'n/a today');
});
