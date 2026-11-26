import { appendFileSync, chmodSync, mkdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { TAIL_BYTES } from '../../src/core/refresh.js';
import { START_BYTES, createClaudeSessions, sessionDirSlug } from '../../src/core/providers/claude-sources.js';
import { NA, readStats } from '../../src/core/providers/index.js';
import { run, type Run } from '../../src/exec.ts';
import { tempHome } from '../helpers/files.ts';
import { CLAUDE_BASIC as BASIC } from './helpers/entries.ts';
import { expect } from './helpers/expect.ts';
import { recordingRun } from './helpers/recording-run.ts';

const NOW = Date.parse('2026-09-07T20:22:00.000Z');
const CWD = '/Users/me/work/app.v1_2';

// A home folder whose Claude Code session folder for `CWD` holds `files`, each with its mtime.
function homeWith(files: { name: string; mtimeMs: number; text: string }[]) {
  const home = tempHome();
  const dir = join(home, '.claude/projects', sessionDirSlug(CWD));
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    writeFileSync(join(dir, file.name), file.text);
    utimesSync(join(dir, file.name), file.mtimeMs / 1000, file.mtimeMs / 1000);
  }
  return { home, dir };
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
    // every `dd` exits 1, as a failed read does
    const { exec } = recordingRun((command) => (command === 'dd' ? Promise.resolve({ code: 1, stdout: '', stderr: 'dd: failed' }) : undefined));
    const stats = await statsOf(home, exec);

    expect(stats.totalTokens).toBe(NA);
    expect(stats.autocompactions).toBe(NA);
  });
});

const OS = (await run('uname', ['-s'])).stdout.trim();
type Named = { path: string; mtimeMs: number; size: number } | null;

describe('a Claude Code session named by its id', () => {
  // The files `names` under a new home's `.claude/projects`; returns that folder.
  function projectsWith(names: string[]) {
    const projects = join(tempHome(), '.claude/projects');
    for (const name of names) {
      mkdirSync(join(projects, name, '..'), { recursive: true });
      writeFileSync(join(projects, name), 'x');
    }
    return projects;
  }

  test('is found in whichever session folder holds it, in one listing', async () => {
    // `three` is sub-agent data, in a folder beside the sessions of `-b`; `four` is in no
    // session folder
    const projects = projectsWith(['-a/one.jsonl', '-a/other.jsonl', '-b/two.jsonl', '-b/two/subagents/three.jsonl', '-b/two/three.jsonl', 'four.jsonl']);
    const { exec, calls } = recordingRun();
    const hook = createClaudeSessions({ execOn: () => exec });

    // the workspace folder is none of the folders the sessions ran in
    const where = { machine: null, cwd: '/elsewhere', home: join(projects, '../..'), os: OS };
    const files: Named[] = await hook.named(where, ['two', null, 'three', 'one', 'four', 'none']);

    expect(files.map((file) => file?.path ?? null)).toEqual([`${projects}/-b/two.jsonl`, null, null, `${projects}/-a/one.jsonl`, null, null]);
    expect(calls.map((call) => call.command)).toEqual(['find']);
    // only the files the ids can name are printed, and the folders beside them not descended
    expect(calls[0].args.slice(0, 4)).toEqual(['-H', projects, '-maxdepth', '2']);
    expect(calls[0].args.filter((arg) => arg.endsWith('.jsonl'))).toEqual(['two.jsonl', 'three.jsonl', 'one.jsonl', 'four.jsonl', 'none.jsonl']);
  });

  test('is found below a projects folder that is a symbolic link', async () => {
    // a dotfile manager keeps the sessions elsewhere and links the folder
    const home = tempHome();
    mkdirSync(join(home, 'kept/-a'), { recursive: true });
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, 'kept/-a/one.jsonl'), 'x');
    symlinkSync(join(home, 'kept'), join(home, '.claude/projects'));
    const { exec } = recordingRun();
    const hook = createClaudeSessions({ execOn: () => exec });

    const [file]: Named[] = await hook.named({ machine: null, cwd: '/elsewhere', home, os: OS }, ['one']);

    expect(file?.path).toBe(`${home}/.claude/projects/-a/one.jsonl`);
  });
});

describe('the folder a Claude Code session records', () => {
  const entry = (fields: object) => `${JSON.stringify({ type: 'user', sessionId: 's1', ...fields })}\n`;
  // the first entries hold no folder, or none that is absolute; the session then moves on
  const START = `${entry({ type: 'summary' })}${entry({ type: 'file-history-snapshot' })}${entry({ cwd: 'relative/app' })}${entry({ cwd: '/work/app/sub' })}`;
  const LATER = entry({ cwd: '/work/other' });
  // lines that carry no figure, far more than the tail window holds
  const FILLER = '{"type":"attachment"}\n'.repeat(Math.ceil((TAIL_BYTES * 2) / 22));

  // A hook over a home whose session `s1` holds `text`, with the session as `named` finds it.
  async function sessionOf(text: string) {
    const { home, dir } = homeWith([{ name: 's1.jsonl', mtimeMs: NOW - 1_000, text }]);
    const { exec, calls } = recordingRun();
    const hook = createClaudeSessions({ execOn: () => exec });
    const [file]: Named[] = await hook.named({ machine: null, cwd: CWD, home, os: OS }, ['s1']);
    const heads = () => calls.filter((call) => call.command === 'head');
    return { hook, file: file!, path: `${dir}/s1.jsonl`, heads };
  }

  test('is the folder it started in, from the text read of a file that fits the tail window', async () => {
    const { hook, file, heads } = await sessionOf(`${START}${LATER}`);

    await hook.read(file, { machine: null });

    expect(await hook.folder(file, { machine: null })).toBe('/work/app/sub');
    expect(heads()).toHaveLength(0);
  });

  test('of a larger file is read from its head, once', async () => {
    const { hook, file, path, heads } = await sessionOf(`${START}${FILLER}${LATER}`);

    await hook.read(file, { machine: null });
    const folders = [await hook.folder(file, { machine: null })];
    // the file grows: where the session started holds
    folders.push(await hook.folder({ ...file, size: file.size + 1, mtimeMs: file.mtimeMs + 1000 }, { machine: null }));

    expect(folders).toEqual(['/work/app/sub', '/work/app/sub']);
    expect(heads().map((call) => call.args)).toEqual([['-c', String(START_BYTES), '--', path]]);
  });

  test('is none for good when the head of a file larger than it holds none', async () => {
    // the first entry with a folder lies behind the head that is read
    const { hook, file, heads } = await sessionOf(`${entry({ type: 'summary' })}${FILLER}${LATER}`);

    const folders = [await hook.folder(file, { machine: null }), await hook.folder(file, { machine: null })];
    // the file grows: it is only appended to, so its head is as it was
    folders.push(await hook.folder({ ...file, size: file.size + 1, mtimeMs: file.mtimeMs + 1000 }, { machine: null }));

    expect(folders).toEqual([null, null, null]);
    expect(heads()).toHaveLength(1);
  });

  test('is asked again when a file that was whole in the head read grew', async () => {
    const { hook, file, path, heads } = await sessionOf(entry({ type: 'summary' }));

    const folders = [await hook.folder(file, { machine: null }), await hook.folder(file, { machine: null })];
    expect(heads()).toHaveLength(1);
    // the first entry with a folder is written after the head was read
    appendFileSync(path, LATER);
    folders.push(await hook.folder({ ...file, size: statSync(path).size, mtimeMs: file.mtimeMs + 1000 }, { machine: null }));

    expect(folders).toEqual([null, null, '/work/other']);
    expect(heads()).toHaveLength(2);
  });

  test('is asked again after a head that could not be read', async () => {
    const { hook, file, path } = await sessionOf(`${START}${FILLER}`);

    // the real `head` fails on a file it may not read, as it would when ssh fails
    chmodSync(path, 0o000);
    const failed = await hook.folder(file, { machine: null });
    chmodSync(path, 0o644);

    expect(failed).toBe(null);
    expect(await hook.folder(file, { machine: null })).toBe('/work/app/sub');
  });
});
