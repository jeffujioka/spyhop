import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { TAIL_BYTES } from '../../src/core/refresh.js';
import { createClaudeSessions, sessionDirSlug } from '../../src/core/providers/claude-sources.js';
import { NA, readStats } from '../../src/core/providers/index.js';
import { run, type Run } from '../../src/exec.ts';
import { expect } from './helpers/expect.ts';

const BASIC = readFileSync(new URL('../fixtures/claude/basic.jsonl', import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-07T20:22:00.000Z');
const CWD = '/Users/me/work/app.v1_2';

const homes: string[] = [];
after(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })));

// A home folder whose Claude Code session folder for `CWD` holds `files`, each with its mtime.
function homeWith(files: { name: string; mtimeMs: number; text: string }[]) {
  const home = mkdtempSync(join(tmpdir(), 'claude-home-'));
  homes.push(home);
  const dir = join(home, '.claude/projects', sessionDirSlug(CWD));
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    writeFileSync(join(dir, file.name), file.text);
    utimesSync(join(dir, file.name), file.mtimeMs / 1000, file.mtimeMs / 1000);
  }
  return { home, dir };
}

// The real runner, recording calls; `ddFails` makes every dd exit 1.
function recordingRun({ ddFails = false } = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const exec: Run = (command, args, options) => {
    calls.push({ command, args });
    if (ddFails && command === 'dd') return Promise.resolve({ code: 1, stdout: '', stderr: 'dd: failed' });
    return run(command, args, options);
  };
  return { exec, calls };
}

// Stats of the session `CWD` links to, as the card builder reads them: link, read, readStats.
async function statsOf(home: string, exec: Run) {
  const hook = createClaudeSessions({ execOn: () => exec });
  const os = (await run('uname', ['-s'])).stdout.trim();
  const file = await hook.link({ machine: null, cwd: CWD, home, os });
  return readStats('claude-code', await hook.read(file, { machine: null }), NOW);
}

describe('claude sessions', () => {
  test('the session folder name keeps letters and digits and turns the rest into dashes', () => {
    expect(sessionDirSlug('/Users/me/work/app')).toBe('-Users-me-work-app');
    expect(sessionDirSlug('/Users/me/.claude')).toBe('-Users-me--claude');
    expect(sessionDirSlug(CWD)).toBe('-Users-me-work-app-v1-2');
  });

  test('a Claude Code folder links to its newest session and reads its tail', async () => {
    const { home, dir } = homeWith([
      { name: 'aaaa.jsonl', mtimeMs: NOW - 3_600_000, text: 'not the session' },
      { name: 'bbbb.jsonl', mtimeMs: NOW - 30_000, text: BASIC },
    ]);
    const { exec, calls } = recordingRun();
    const stats = await statsOf(home, exec);

    expect(stats.model).toBe('claude-opus-4-6');
    expect(stats.totalTokens).toBe(180562);
    // a file no larger than the tail window is read whole, so its compactions are counted
    expect(stats.autocompactions).toBe(0);
    expect(calls.find((c) => c.command === 'tail')?.args).toEqual(['-c', String(TAIL_BYTES), '--', `${dir}/bbbb.jsonl`]);
  });

  // the session of BASIC, then lines that carry no figure, far more than the tail window holds
  const big = () => ({
    name: 'cccc.jsonl',
    mtimeMs: NOW - 1_000,
    text: `${BASIC}${'{"type":"attachment"}\n'.repeat(Math.ceil((TAIL_BYTES * 2) / 22))}`,
  });

  test('a large session is read through its tail and its whole file', async () => {
    const { home } = homeWith([big()]);
    const { exec, calls } = recordingRun();
    const stats = await statsOf(home, exec);

    // the session lies before the tail window: its totals come from the whole-file scan, and
    // what is about the end of the file (the model of the latest reply) is not in the tail
    expect(stats.totalTokens).toBe(180562);
    expect(stats.autocompactions).toBe(0);
    expect(stats.model).toBe(NA);
    expect(calls.some((c) => c.command === 'dd')).toBe(true);
  });

  test('a large session whose scan fails has no totals and no compaction count', async () => {
    const { home } = homeWith([big()]);
    const { exec } = recordingRun({ ddFails: true });
    const stats = await statsOf(home, exec);

    expect(stats.totalTokens).toBe(NA);
    expect(stats.autocompactions).toBe(NA);
  });
});
