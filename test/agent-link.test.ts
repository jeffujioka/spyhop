// Which harness session a local Orca agent's card links to: the one Orca names by the agent's
// sessionId, else the newest of the workspace folder, shared out by title among the agents of
// one harness there; agents on one session share a card.
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sessionDirSlug as claudeSlug } from '../src/core/providers/claude-sources.js';
import { sessionDirSlug as ompSlug } from '../src/core/providers/omp-sources.js';
import { run, type Run } from '../src/exec.ts';
import { NOW, agent, cardsOf, costOf, opencodeDatabase, sessions, tokensOf, workspace } from './helpers/agent-cards.ts';
import { fixtureText, tempHome } from './helpers/files.ts';

// The ids of the omp fixtures' sessions (their `session` entries); omp names a session file
// `<start time>_<id>.jsonl`. basic.jsonl logs $0.06, compacted.jsonl $0.05.
const BASIC = { from: 'omp/basic.jsonl', id: '00000000-0000-7000-8000-000000000001', cost: '$0.06' };
const COMPACTED = { from: 'omp/compacted.jsonl', id: '00000000-0000-7000-8000-0000000000c1', cost: '$0.05' };

// Writes an omp session of the fixture into the sessions folder of `path`, with `title` in its
// title line and modified `minutesAgo` before NOW.
function ompSession(home: string, path: string, session: typeof BASIC, minutesAgo: number, title = 'redacted title') {
  const dir = join(home, '.omp/agent/sessions', ompSlug(path, home));
  const file = join(dir, `2026-11-02T10-00-00-000Z_${session.id}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, fixtureText(session.from).replace('"title":"redacted title"', `"title":${JSON.stringify(title)}`));
  const time = new Date(NOW - minutesAgo * 60_000);
  utimesSync(file, time, time);
}

// Claude Code names a session file `<id>.jsonl`: `aaaa` holds basic.jsonl (181k tokens) and is
// the newest, `bbbb` holds no-usage.jsonl (no tokens).
function claudeSessions(home: string, path: string) {
  const dir = join(home, '.claude/projects', claudeSlug(path));
  sessions(dir, { 'aaaa.jsonl': 'claude/basic.jsonl', 'bbbb.jsonl': 'claude/no-usage.jsonl' });
  utimesSync(join(dir, 'aaaa.jsonl'), new Date(NOW - 60_000), new Date(NOW - 60_000));
  utimesSync(join(dir, 'bbbb.jsonl'), new Date(NOW - 30 * 60_000), new Date(NOW - 30 * 60_000));
}

// The real runner, counting the `head` runs (omp's title reads) and the most at once.
function countingHeads() {
  const heads = { runs: 0, running: 0, most: 0 };
  const exec: Run = async (command, args, options) => {
    if (command !== 'head') return run(command, args, options);
    heads.runs += 1;
    heads.most = Math.max(heads.most, ++heads.running);
    try {
      return await run(command, args, options);
    } finally {
      heads.running -= 1;
    }
  };
  return { exec, heads };
}

// omp sessions s1…s<count> in the folder `path`, s1 the newest, each with its own title.
function ompSessions(home: string, path: string, count: number) {
  const ids = Array.from({ length: count }, (_, i) => `00000000-0000-7000-8000-00000000000${i + 1}`);
  ids.forEach((id, i) => ompSession(home, path, { ...BASIC, id }, i + 1, `Task ${i + 1}`));
  return ids;
}

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
  claudeSessions(home, path);

  const cards = await cardsOf(home, [
    agent({ id: 't1', agent: 'claude', path }),
    agent({ id: 't2', agent: 'claude', path }),
  ]);

  assert.equal(cards.length, 1);
  // basic.jsonl, the newest, logs 181k tokens; no-usage.jsonl logs none
  assert.equal(tokensOf(cards[0].model), '181k');
});

test('Two Claude Code agents told apart by session id', async () => {
  const home = tempHome();
  const path = workspace(home, 'app');
  claudeSessions(home, path);

  const cards = await cardsOf(home, [
    agent({ id: 't1', agent: 'claude', sessionId: 'bbbb', path }),
    agent({ id: 't2', agent: 'claude', sessionId: 'aaaa', path }),
  ]);

  assert.deepEqual(
    cards.map(({ card, model }) => [card.id, tokensOf(model)]),
    [
      ['t1', 'n/a'],
      ['t2', '181k'],
    ],
  );
});

test('A session id that names no session links as without one', async () => {
  const home = tempHome();
  const path = workspace(home, 'app');
  claudeSessions(home, path);

  const [{ model }] = await cardsOf(home, [agent({ agent: 'claude', sessionId: 'cccc', path })]);

  // the newest session, as for an agent without a session id
  assert.equal(tokensOf(model), '181k');
});

test('Two opencode agents told apart by session id', async () => {
  const home = tempHome();
  opencodeDatabase(home);

  // the fixture's sessions of /work/demo: ses_basic, the newest, logs $0.41; ses_old no message
  const cards = await cardsOf(home, [
    agent({ id: 't1', agent: 'opencode', sessionId: 'ses_old', path: '/work/demo' }),
    agent({ id: 't2', agent: 'opencode', sessionId: 'ses_basic', path: '/work/demo' }),
  ]);

  assert.deepEqual(
    cards.map(({ card, model }) => [card.id, costOf(model)]),
    [
      ['t1', 'n/a'],
      ['t2', '$0.41'],
    ],
  );
});

test('An agent without a session id never takes a named session', async () => {
  const home = tempHome();
  const path = workspace(home, 'app');
  claudeSessions(home, path);
  opencodeDatabase(home);

  // aaaa and ses_basic, their folders' newest sessions, are named by an id
  const cards = await cardsOf(home, [
    agent({ id: 'c1', agent: 'claude', sessionId: 'aaaa', path }),
    agent({ id: 'c2', agent: 'claude', path }),
    agent({ id: 'o1', agent: 'opencode', sessionId: 'ses_basic', path: '/work/demo' }),
    agent({ id: 'o2', agent: 'opencode', path: '/work/demo' }),
  ]);

  // c2 links to bbbb and o2 to ses_old: each card reads what a card linked to that session by
  // its id reads, which an unlinked card does not (no-usage.jsonl has a model and a duration,
  // ses_old a compaction count of 0)
  const byId = async (harness: string, sessionId: string, at: string) =>
    (await cardsOf(home, [agent({ agent: harness, sessionId, path: at })]))[0].card.stats;
  const stats = Object.fromEntries(cards.map(({ card }) => [card.id, card.stats]));
  assert.deepEqual(stats.c2, await byId('claude', 'bbbb', path));
  assert.deepEqual(stats.o2, await byId('opencode', 'ses_old', '/work/demo'));
  assert.deepEqual(
    cards.map(({ card, model }) => [card.id, card.harness === 'claude' ? tokensOf(model) : costOf(model)]),
    [
      ['c1', '181k'],
      ['c2', 'n/a'],
      ['o1', '$0.41'],
      ['o2', 'n/a'],
    ],
  );
});

test('An omp agent without a session id, every session of its folder named, reads n/a', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  ompSession(home, path, BASIC, 1);
  ompSession(home, path, COMPACTED, 30);

  const cards = await cardsOf(home, [
    agent({ id: 't1', agent: 'omp', sessionId: BASIC.id, path }),
    agent({ id: 't2', agent: 'omp', sessionId: COMPACTED.id, path }),
    agent({ id: 't3', agent: 'omp', path }),
  ]);

  // t3 links to no session, and has a card of its own
  assert.deepEqual(
    cards.map(({ card, model }) => [card.id, costOf(model)]),
    [
      ['t1', BASIC.cost],
      ['t2', COMPACTED.cost],
      ['t3', 'n/a'],
    ],
  );
});

test('Session ids that name their sessions read no title', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  const ids = ompSessions(home, path, 5);
  const { exec, heads } = countingHeads();

  const cards = await cardsOf(
    home,
    [agent({ id: 't1', agent: 'omp', sessionId: ids[3], path }), agent({ id: 't2', agent: 'omp', sessionId: ids[4], path })],
    exec,
  );

  assert.equal(cards.length, 2);
  assert.equal(heads.runs, 0);
});

test('Titles are read for the unnamed agents only, a few at a time', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  const ids = ompSessions(home, path, 9);
  const { exec, heads } = countingHeads();

  // one named agent and six unnamed: titles of the six newest sessions the id did not name
  const unnamed = Array.from({ length: 6 }, (_, i) => agent({ id: `u${i}`, agent: 'omp', title: `π > Task ${i + 1}`, path }));
  const cards = await cardsOf(home, [agent({ id: 'n', agent: 'omp', sessionId: ids[8], path }), ...unnamed], exec);

  assert.equal(cards.length, 7);
  assert.equal(heads.runs, 6);
  assert.ok(heads.most <= 4, `${heads.most} title reads at once`);
});
