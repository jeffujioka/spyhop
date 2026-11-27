// How src/core/format.js writes a folder, its path, its git remote and a session's title for
// reading.
import { test } from 'node:test';
import { formatFolderName, formatHomePath, formatRemote, formatSessionTitle } from '../../src/core/format.js';
import { expect } from './helpers/expect.ts';

const HOME = '/Users/me';

test('the folder, the remote and the machine are written for reading', () => {
  // home is shown as ~, elsewhere the full path; the name is the folder's own name
  expect([formatFolderName(HOME), formatHomePath(HOME, HOME)]).toEqual(['me', '~']);
  expect([formatFolderName('/srv/app'), formatHomePath('/srv/app', HOME)]).toEqual(['app', '/srv/app']);
  // a folder on another machine, whose home is not known, is not under this computer's home
  expect(formatHomePath(`${HOME}/x`, null)).toBe(`${HOME}/x`);
  // a folder named like the home's start but not inside it
  expect(formatHomePath(`${HOME}-old/x`, HOME)).toBe(`${HOME}-old/x`);

  // scheme, credentials already masked, user and `.git` are left out
  expect(formatRemote('git@github.com:jeffujioka/dotfiles.git')).toBe('github.com/jeffujioka/dotfiles');
  expect(formatRemote('https://***@gitlab.example.com/team/app.git')).toBe('gitlab.example.com/team/app');
  expect(formatRemote('ssh://git@host.example:2222/team/app')).toBe('host.example:2222/team/app');
  expect(formatRemote(null)).toBeNull();
});

test("a session title is shown without the harness prefix and never repeats the folder's name", () => {
  // the session title: the Orca agent's title without the harness prefix, so two cards of one
  // folder can be told apart; none when the session is untitled (its title is the folder's name)
  const folder = `${HOME}/projects/jeffujioka`;
  const session = (title: string | null, harness = 'omp') => formatSessionTitle(title, folder, harness);
  expect(session('π > Fix the login bug')).toEqual({ value: 'Fix the login bug', tone: 'normal' });
  expect(session('π > \uE0A0 Fix the login bug')?.value).toBe('\uE0A0 Fix the login bug');
  expect(session('\uE0A0 Fix the login bug')?.value).toBe('\uE0A0 Fix the login bug');
  expect(session('π > jeffujioka')).toBeNull();
  expect(session('jeffujioka')).toBeNull();
  expect(session('π >  ')).toBeNull();
  expect(session(null)).toBeNull();
  // another harness: the title as it is, unless it is the folder's name
  expect(session('Refactor the parser', 'claude-code')?.value).toBe('Refactor the parser');
  expect(session('π > Refactor', 'claude-code')?.value).toBe('π > Refactor');
  expect(session('jeffujioka', 'claude-code')).toBeNull();
});
