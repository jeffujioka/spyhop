import { describe, test } from 'node:test';
import { collapseBySession, linkSession, shareSessions } from '../../src/core/session-link.js';
import { expect } from './helpers/expect.ts';

const NOW = Date.parse('2026-05-01T12:00:00Z');
const MIN = 60_000;
const file = (path, minutesAgo, title) => ({ path, mtimeMs: NOW - minutesAgo * MIN, ...(title === undefined ? {} : { title }) });

describe('Pane to session link', () => {
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

  test('panes in one folder get their own sessions', () => {
    // two panes in one folder: their terminal titles contain the titles of two sessions
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

  test('a pane without a title match takes the newest unmatched session', () => {
    const files = [file('/s/c.jsonl', 1, ''), file('/s/b.jsonl', 5, ''), file('/s/a.jsonl', 30, 'FACT: Enable factory config')];
    // the first pane is a new session with no title yet (its terminal title is the folder name)
    const titles = ['π > jeffujioka', 'π > FACT: Enable factory config'];

    expect(shareSessions(files, titles).map((f) => f.path)).toEqual(['/s/c.jsonl', '/s/a.jsonl']);
    // several unmatched panes take the unmatched sessions newest first, in pane order
    expect(shareSessions(files, ['x', 'y', 'z']).map((f) => f.path)).toEqual(['/s/c.jsonl', '/s/b.jsonl', '/s/a.jsonl']);
    // panes beyond the sessions get the newest session; no files gives null
    expect(shareSessions([files[0]], ['x', 'y']).map((f) => f.path)).toEqual(['/s/c.jsonl', '/s/c.jsonl']);
    expect(shareSessions([], ['x', 'y'])).toEqual([null, null]);
  });
});

describe('One card per agent pane', () => {
  test('same session collapses to one', () => {
    const panes = [
      { paneId: 'p1', sessionPath: '/s/a.jsonl' },
      { paneId: 'p2', sessionPath: '/s/a.jsonl' },
      { paneId: 'p3', sessionPath: '/s/b.jsonl' },
      { paneId: 'p4', sessionPath: null },
      { paneId: 'p5', sessionPath: null },
    ];

    const cards = collapseBySession(panes);

    expect(cards.map((pane) => pane.paneId)).toEqual(['p1', 'p3', 'p4', 'p5']);
  });
});
