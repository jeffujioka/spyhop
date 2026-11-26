// Ported from herdr-session-stats (test/session-link.test.js), its herdr panes named here as
// the Orca agents spyhop links.
import { describe, test } from 'node:test';
import { collapseBySession, linkAgents, linkSession, shareSessions } from '../../src/core/session-link.js';
import { MINUTE as MIN } from './helpers/entries.ts';
import { expect } from './helpers/expect.ts';

const NOW = Date.parse('2026-05-01T12:00:00Z');
const file = (path, minutesAgo, title) => ({ path, mtimeMs: NOW - minutesAgo * MIN, ...(title === undefined ? {} : { title }) });

describe('Orca agent to session link', () => {
  test('newest file wins', () => {
    const files = [file('/s/c.jsonl', 9), file('/s/a.jsonl', 1), file('/s/b.jsonl', 2)];

    expect(linkSession(files)).toBe('/s/a.jsonl');
  });

  test('an idle file is still linked', () => {
    // however long ago it changed
    expect(linkSession([file('/s/old.jsonl', 20)])).toBe('/s/old.jsonl');
    expect(linkSession([file('/s/ancient.jsonl', 60 * 24 * 30), file('/s/old.jsonl', 20)])).toBe('/s/old.jsonl');
  });

  test('no files is not linked', () => {
    expect(linkSession([])).toBeNull();
  });

  test('agents in one folder get their own sessions', () => {
    // two agents in one folder: their titles contain the titles of two sessions
    const files = [file('/s/new.jsonl', 1, 'Fix the login bug'), file('/s/old.jsonl', 30, 'FACT: Enable factory config')];
    const titles = ['π > FACT: Enable factory config', 'π > Fix the login bug'];

    expect(shareSessions(files, titles).map((f) => f.path)).toEqual(['/s/old.jsonl', '/s/new.jsonl']);
    // the longest title wins when several match, and a session is given only once
    const nested = [file('/s/a.jsonl', 1, 'login'), file('/s/b.jsonl', 2, 'Fix the login bug')];
    expect(shareSessions(nested, ['π > Fix the login bug', 'π > Fix the login bug']).map((f) => f.path)).toEqual([
      '/s/b.jsonl',
      '/s/a.jsonl',
    ]);
  });

  test('an agent without a title match gets no session', () => {
    const files = [file('/s/c.jsonl', 1, ''), file('/s/b.jsonl', 5, 'Fix the login bug'), file('/s/a.jsonl', 30, 'FACT: Enable factory config')];
    // the first agent is a new session with no title yet (its title is the folder name)
    const titles = ['π > jeffujioka', 'π > FACT: Enable factory config'];

    expect(shareSessions(files, titles)).toEqual([null, files[2]]);
    // also when one agent and one session are left, and for an agent that has no title
    expect(shareSessions([files[1]], ['x'])).toEqual([null]);
    expect(shareSessions([files[1]], [null])).toEqual([null]);
    // a session without a title is nobody's
    expect(shareSessions([files[0]], ['x', ''])).toEqual([null, null]);
    // two agents whose titles both contain one session's title: the first of them gets it
    expect(shareSessions([files[1]], ['π > Fix the login bug', 'π - Fix the login bug - boto'])).toEqual([files[1], null]);
    expect(shareSessions([], ['x', 'y'])).toEqual([null, null]);
  });

  test('agents whose session id named a session keep it; the others share the candidates', () => {
    const named = file('/s/named.jsonl', 40);
    const candidates = [file('/s/new.jsonl', 1, 'Fix the login bug'), file('/s/old.jsonl', 30, 'Write the docs')];
    const agents = [{ title: 'π > Write the docs' }, { title: 'anything' }, { title: 'π > Fix the login bug' }];

    expect(linkAgents([null, named, null], candidates, agents).map((f) => f.path)).toEqual(['/s/old.jsonl', '/s/named.jsonl', '/s/new.jsonl']);
    // an unnamed agent whose title matches no candidate is unlinked, and so is one without candidates
    expect(linkAgents([named, null], candidates, [agents[1], agents[1]])).toEqual([named, null]);
    expect(linkAgents([named, null], [], agents.slice(0, 2))).toEqual([named, null]);
  });
});

describe('One card per Orca agent', () => {
  test('same session collapses to one', () => {
    const agents = [
      { id: 'a1', sessionPath: '/s/a.jsonl' },
      { id: 'a2', sessionPath: '/s/a.jsonl' },
      { id: 'a3', sessionPath: '/s/b.jsonl' },
      { id: 'a4', sessionPath: null },
      { id: 'a5', sessionPath: null },
    ];

    const cards = collapseBySession(agents);

    expect(cards.map((agent) => agent.id)).toEqual(['a1', 'a3', 'a4', 'a5']);
  });
});
