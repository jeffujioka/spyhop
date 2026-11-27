// What the worker's answers carry: the fleet answer (`spyhop.fleet`) no series of the session
// screen, and the session answer (`spyhop.session`) the series of the one card asked, or no
// session for a card Orca no longer lists. The worker is the real one, on this computer's Orca
// host as the test kit plays it, over omp session files under a temporary home
// (test/helpers/live.ts).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { SERIES_POINTS } from '../src/core/series.js';
import { fleetOf, ompCalls, sessionOf } from './helpers/live.ts';

// The contexts after `count` model calls, each one more than the one before.
const contexts = (count: number) => Array.from({ length: count }, (_, i) => 1000 + i);

// The workspace `api`/`main` with one working omp agent per title, each linked to the session of
// its title, of 400 model calls, in a sub-folder of its own: the workspaces, and what puts the
// sessions under the home.
function sessions(titles: string[]) {
  return {
    workspaces: [{ project: 'api', name: 'main', agents: titles.map(() => 'working' as const), titles: titles.map((title) => `π - ${title}`) }],
    prepare: (home: string) => {
      // in the folder Orca reports for the workspace `api`/`main` (test/helpers/orca-host.ts)
      titles.forEach((title, i) => ompCalls(home, join(home, 'work/api-main', `s${i}`), { title, contexts: contexts(400) }));
    },
  };
}

test('Fleet answer without the series of the session screen', async () => {
  const { workspaces, prepare } = sessions(['Fix the login bug']);
  const { answer } = await fleetOf(workspaces, { prepare });

  const [card] = answer.groups.flatMap((group) => group.cards);
  assert.deepEqual(card.context.spark, contexts(400).slice(-30));
  assert.doesNotMatch(JSON.stringify(answer), /"(points|read|write|uncached|output|marks)":/);
});

test('Series for the open session screen only', async () => {
  // `b` listed first, so the card asked for is not the first one
  const { workspaces, prepare } = sessions(['Session b', 'Session a']);
  const { answer, fleet } = await sessionOf(workspaces, { prepare, card: (cards) => cards.find((card) => card.title === 'Session a')!.id });

  const b = fleet.groups.flatMap((group) => group.cards).find((card) => card.title === 'Session b')!;
  assert.equal(answer.session?.card.title, 'Session a');
  const points = answer.session!.tokens!.points;
  assert.equal(points.reduce((sum, point) => sum + point.n, 0), 400);
  assert.ok(points.length <= SERIES_POINTS, String(points.length));
  const json = JSON.stringify(answer);
  assert.ok(!json.includes(JSON.stringify(b.id).slice(1, -1)), 'holds the id of b');
  assert.ok(!json.includes('Session b'), 'holds the title of b');
});

test('a card Orca no longer lists answers no session', async () => {
  const { workspaces, prepare } = sessions(['Fix the login bug']);
  const { answer } = await sessionOf(workspaces, { prepare, card: () => 'gone' });

  assert.deepEqual(answer, { request: 2, session: null });
});
