// Which harness session a local Orca agent's card links to: the one Orca names by the agent's
// sessionId, else the newest of the workspace folder, shared out by title among the agents of
// one harness there; agents on one session share a card.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NOW, agent, cardsOf, fixture, sessions, tempHome, workspace } from './helpers/agent-cards.ts';

// The ids of the omp fixtures' sessions (their `session` entries); omp names a session file
// `<start time>_<id>.jsonl`. basic.jsonl logs $0.06, compacted.jsonl $0.05.
const BASIC = { from: 'omp/basic.jsonl', id: '00000000-0000-7000-8000-000000000001', cost: '$0.06' };
const COMPACTED = { from: 'omp/compacted.jsonl', id: '00000000-0000-7000-8000-0000000000c1', cost: '$0.05' };

// Writes an omp session of the fixture into the sessions folder of `path`, with `title` in its
// title line and modified `minutesAgo` before NOW.
function ompSession(home: string, path: string, session: typeof BASIC, minutesAgo: number, title = 'redacted title') {
  const dir = join(home, '.omp/agent/sessions', path.slice(home.length).replace(/\//g, '-'));
  const file = join(dir, `2026-11-02T10-00-00-000Z_${session.id}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, readFileSync(fixture(session.from), 'utf8').replace('"title":"redacted title"', `"title":${JSON.stringify(title)}`));
  const time = new Date(NOW - minutesAgo * 60_000);
  utimesSync(file, time, time);
}

const costOf = (model: { groups: Array<{ hero?: { value: string } }> }) => model.groups[2].hero?.value;

test('Orca names the session', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  ompSession(home, path, BASIC, 1);
  ompSession(home, path, COMPACTED, 30);

  const [{ model }] = await cardsOf(home, [agent({ agent: 'omp', sessionId: COMPACTED.id, path })]);

  assert.equal(costOf(model), COMPACTED.cost);
});

test('No session id', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  ompSession(home, path, BASIC, 30);
  ompSession(home, path, COMPACTED, 1);

  const [{ model }] = await cardsOf(home, [agent({ agent: 'omp', sessionId: null, path })]);

  assert.equal(costOf(model), COMPACTED.cost);
});

test('Two omp agents told apart by title', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  ompSession(home, path, BASIC, 1, 'Fix the login bug');
  ompSession(home, path, COMPACTED, 30, 'Write the docs');

  const cards = await cardsOf(home, [
    agent({ id: 't1', agent: 'omp', title: 'π > Write the docs', path }),
    agent({ id: 't2', agent: 'omp', title: 'π > Fix the login bug', path }),
  ]);

  assert.deepEqual(
    cards.map(({ card, model }) => [card.id, costOf(model)]),
    [
      ['t1', COMPACTED.cost],
      ['t2', BASIC.cost],
    ],
  );
});

test('Two agents on one session share a card', async () => {
  const home = tempHome();
  const path = workspace(home, 'app');
  const dir = join(home, '.claude/projects', path.replace(/[^a-zA-Z0-9]/g, '-'));
  sessions(dir, { 'aaaa.jsonl': 'claude/basic.jsonl', 'bbbb.jsonl': 'claude/no-usage.jsonl' });
  utimesSync(join(dir, 'aaaa.jsonl'), new Date(NOW - 60_000), new Date(NOW - 60_000));
  utimesSync(join(dir, 'bbbb.jsonl'), new Date(NOW - 30 * 60_000), new Date(NOW - 30 * 60_000));

  const cards = await cardsOf(home, [
    agent({ id: 't1', agent: 'claude', path }),
    agent({ id: 't2', agent: 'claude', path }),
  ]);

  assert.equal(cards.length, 1);
  // basic.jsonl, the newest, logs 181k tokens; no-usage.jsonl logs none
  const tokens = cards[0].model.groups[2].figures.find((entry: { label: string }) => entry.label === 'Tokens');
  assert.equal(tokens?.value, '181k');
});
