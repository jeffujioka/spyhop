import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { findNamedFiles, findSessionFile, listFilesOfFolders } from '../../src/core/providers/session-files.js';
import { tempHome } from '../helpers/files.ts';
import { expect } from './helpers/expect.ts';
import { recordingRun } from './helpers/recording-run.ts';

const NOW = Date.parse('2026-11-15T12:00:00Z');

// A session folder holding one fresh 42-byte session file, a.jsonl.
function sessionFolder() {
  const dir = tempHome();
  writeFileSync(join(dir, 'a.jsonl'), 'x'.repeat(42));
  utimesSync(join(dir, 'a.jsonl'), (NOW - 1000) / 1000, (NOW - 1000) / 1000);
  return dir;
}

// The `stat` of the command line: the program after `-exec` and its arguments up to `{}`
const statOf = (args: string[]) => args.slice(args.indexOf('-exec') + 1, args.indexOf('{}'));

describe('finding a session file', () => {
  test('on macOS the system stat is run, whatever stat comes first in PATH', async () => {
    const dir = sessionFolder();
    const { exec, calls } = recordingRun();
    const file = await findSessionFile(exec, { dir, os: 'Darwin' });

    expect(file).toEqual({ path: `${dir}/a.jsonl`, mtimeMs: Math.floor((NOW - 1000) / 1000) * 1000, size: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('find');
    // a GNU stat first in PATH would read -f as a filesystem report
    expect(statOf(calls[0].args)).toEqual(['/usr/bin/stat', '-f', '%m %z %N']);
  });

  test('on a Linux remote host stat is GNU stat', async () => {
    // stands in for a Linux remote host, which cannot run beside the test: records the command
    // line and prints the `stat` line of one file
    const { exec: linuxHost, calls } = recordingRun(async () => ({
      code: 0,
      stdout: `${Math.floor((NOW - 1000) / 1000)} 42 /home/u/s/a.jsonl\n`,
      stderr: '',
    }));
    await findSessionFile(linuxHost, { dir: '/home/u/s', os: 'Linux' });

    expect(statOf(calls[0].args)).toEqual(['stat', '-c', '%Y %s %n']);
  });

  test('another system has no session file and runs nothing', async () => {
    const { exec, calls } = recordingRun();

    expect(await findSessionFile(exec, { dir: sessionFolder(), os: 'Plan9' })).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('finding the session files that ids name', () => {
  // omp's rule: a session file is `<start time>_<id>.jsonl`
  const where = (dir: string) => ({ dir, os: 'Darwin', depth: 2, pattern: (id: string) => `*_${id}.jsonl` });
  const names = (path: string, id: string) => path.endsWith(`_${id}.jsonl`);

  test('below a folder, in one listing of the files the ids can name', async () => {
    const root = tempHome();
    for (const file of ['-a/t_one.jsonl', '-a/t_other.jsonl', '-b/t_two.jsonl']) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), 'x');
    }
    const { exec, calls } = recordingRun();

    const files = await findNamedFiles(exec, where(root), ['two', null, 'none', 'one'], names);

    expect(files.map((file: { path: string } | null) => file?.path ?? null)).toEqual([`${root}/-b/t_two.jsonl`, null, null, `${root}/-a/t_one.jsonl`]);
    expect(calls).toHaveLength(1);
    // the listing prints the files of those names only
    expect(calls[0].args.filter((arg) => arg.endsWith('.jsonl'))).toEqual(['*_two.jsonl', '*_none.jsonl', '*_one.jsonl']);
  });

  test('below a folder that is a symbolic link', async () => {
    // a dotfile manager keeps the sessions elsewhere and links the folder
    const home = tempHome();
    mkdirSync(join(home, 'kept/-a'), { recursive: true });
    writeFileSync(join(home, 'kept/-a/t_one.jsonl'), 'x');
    symlinkSync(join(home, 'kept'), join(home, 'sessions'));
    const { exec } = recordingRun();

    const [file] = await findNamedFiles(exec, where(join(home, 'sessions')), ['one'], names);

    expect(file?.path).toBe(`${home}/sessions/-a/t_one.jsonl`);
  });
});

describe('listing the session files of the folders named alike', () => {
  test('in one listing, newest first, the prefix taken as it is written', async () => {
    const root = tempHome();
    for (const file of ['-p/old.jsonl', '-p-sub/new.jsonl', '-p/notes.txt', '-q/other.jsonl', '-[p]-sub/odd.jsonl']) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), 'x');
    }
    utimesSync(join(root, '-p/old.jsonl'), (NOW - 60_000) / 1000, (NOW - 60_000) / 1000);
    utimesSync(join(root, '-p-sub/new.jsonl'), NOW / 1000, NOW / 1000);
    const { exec, calls } = recordingRun();

    const alike = await listFilesOfFolders(exec, { dir: root, os: 'Darwin', prefix: '-p' });
    // `[p]` names the folder `-[p]-sub`, not every folder that starts with `-p`
    const odd = await listFilesOfFolders(exec, { dir: root, os: 'Darwin', prefix: '-[p]' });

    expect(alike.map((file: { path: string }) => file.path)).toEqual([`${root}/-p-sub/new.jsonl`, `${root}/-p/old.jsonl`]);
    expect(odd.map((file: { path: string }) => file.path)).toEqual([`${root}/-[p]-sub/odd.jsonl`]);
    expect(calls).toHaveLength(2);
  });
});
