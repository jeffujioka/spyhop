import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { findSessionFile } from '../../src/core/providers/session-files.js';
import { run } from '../../src/exec.ts';
import { expect } from './helpers/expect.ts';

const NOW = Date.parse('2026-11-15T12:00:00Z');

const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

// A session folder holding one fresh 42-byte session file, a.jsonl.
function sessionFolder() {
  const dir = mkdtempSync(join(tmpdir(), 'spyhop-sessions-'));
  roots.push(dir);
  writeFileSync(join(dir, 'a.jsonl'), 'x'.repeat(42));
  utimesSync(join(dir, 'a.jsonl'), (NOW - 1000) / 1000, (NOW - 1000) / 1000);
  return dir;
}

// The real runner, recording calls.
function recordingRun() {
  const calls: { command: string; args: string[] }[] = [];
  const exec = (command: string, args: string[]) => {
    calls.push({ command, args });
    return run(command, args);
  };
  return { exec, calls };
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
    const calls: { command: string; args: string[] }[] = [];
    const linuxHost = async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { code: 0, stdout: `${Math.floor((NOW - 1000) / 1000)} 42 /home/u/s/a.jsonl\n`, stderr: '' };
    };
    await findSessionFile(linuxHost, { dir: '/home/u/s', os: 'Linux' });

    expect(statOf(calls[0].args)).toEqual(['stat', '-c', '%Y %s %n']);
  });

  test('another system has no session file and runs nothing', async () => {
    const { exec, calls } = recordingRun();

    expect(await findSessionFile(exec, { dir: sessionFolder(), os: 'Plan9' })).toBeNull();
    expect(calls).toEqual([]);
  });
});
