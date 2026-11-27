// A test of the live panel ends only once every request it or the panel sent has settled, before
// its environment is set back (test/helpers/env.ts): the worker's build reads `PATH` and
// ORCA_CLI_COMMAND each time it starts a program, so a build left running would start this
// computer's real `orca` and `ssh`, and then the next test's stand-ins, logged as that test's calls.
// The first test ends with its first fleet request out; the second checks it had settled.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ompSessionOf } from '../helpers/agent-cards.ts';
import { openLive, until } from '../helpers/live.ts';
import type { HostWorkspace } from '../helpers/orca-host.ts';
import { standIns } from '../helpers/stand-ins.ts';

// This computer's workspace `api`/`main`, with one working omp agent on the session `s1`.
const MAIN: HostWorkspace = { project: 'api', name: 'main', agents: ['working'], sessionId: 's1' };

// How many fleet requests the first test's panel started, and how many of them settled.
let requests = () => 0;
let settled = () => 0;

test('a test may end with a request out', async () => {
  // openLive returns once the first request has started, before it can have been answered
  const opened = await openLive([MAIN], { prepare: (home) => ompSessionOf(home, join(home, 'work/api-main')) });
  requests = () => opened.requests('spyhop.fleet');
  settled = () => opened.settled('spyhop.fleet');
  assert.equal(requests(), 1);
});

test('the next test starts once those requests have settled', async () => {
  const settledAtStart = settled();
  const calls = standIns({ homes: {}, orca: {} });
  await until(() => settled() === requests());

  assert.equal(settledAtStart, requests());
  // what the first test's request ran was not logged by this test's stand-ins
  assert.deepEqual([calls.orca(), calls.ssh()], [[], []]);
});
