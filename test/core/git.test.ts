import { join } from 'node:path';
import { describe, test } from 'node:test';
import { readGit } from '../../src/core/git.js';
import { run, type RunResult } from '../../src/exec.ts';
import { tempHome } from '../helpers/files.ts';
import { expect } from './helpers/expect.ts';
import { recordingRun } from './helpers/recording-run.ts';

// git reads no config of the person running the tests (a `url.insteadOf` would rewrite the URLs)
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

async function git(cwd: string, ...args: string[]) {
  const result = await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

// A real repository with one commit on `branch`, its `origin` remote set when one is given;
// `detached` checks out that commit itself, so HEAD names no branch.
async function repo({ branch = 'main', origin = null as string | null, detached = false } = {}) {
  const folder = tempHome();
  await git(folder, 'init', '-q', '-b', branch);
  await git(folder, 'commit', '-q', '--allow-empty', '-m', 'first');
  if (origin !== null) await git(folder, 'remote', 'add', 'origin', origin);
  if (detached) await git(folder, 'checkout', '-q', '--detach');
  return folder;
}

// Stands in for a remote host, which cannot run beside the test: a call `on` a machine is
// answered by `remote`; every other call runs here for real.
const withRemoteHost = (remote: (args: string[]) => Promise<RunResult>) =>
  recordingRun((_command, args, options) => (options.on ? remote(args) : undefined));

const ORIGIN = 'git@github.com:jeffujioka/spyhop.git';

describe('git', () => {
  test('branch and origin', async () => {
    const folder = await repo({ branch: 'feat/cards', origin: ORIGIN });
    const { exec, calls } = recordingRun();
    expect(await readGit({ exec }, { cwd: folder })).toEqual({ branch: 'feat/cards', origin: ORIGIN });
    expect(calls.map((call) => [call.command, call.args, call.options.cwd])).toEqual([
      ['git', ['branch', '--show-current'], folder],
      ['git', ['remote', 'get-url', 'origin'], folder],
    ]);
  });

  test('no git means no lines', async () => {
    const { exec } = recordingRun();
    expect(await readGit({ exec }, { cwd: tempHome() })).toEqual({ branch: null, origin: null });
    expect(await readGit({ exec }, { cwd: await repo({ branch: 'main' }) })).toEqual({ branch: 'main', origin: null });
    expect(await readGit({ exec }, { cwd: await repo({ origin: ORIGIN, detached: true }) })).toEqual({ branch: null, origin: ORIGIN });
  });

  test('a remote host is asked through on', async () => {
    const folder = await repo({ branch: 'here', origin: 'https://example.com/here.git' });
    const { exec, calls } = withRemoteHost(async (args) => ({
      code: 0,
      stdout: `${args[0] === 'branch' ? 'there' : ORIGIN}\n`,
      stderr: '',
    }));
    expect(await readGit({ exec }, { cwd: folder, on: 'dev-box' })).toEqual({ branch: 'there', origin: ORIGIN });
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.options.on).toBe('dev-box');

    // a folder on this computer is asked here: no `on`
    calls.length = 0;
    expect(await readGit({ exec }, { cwd: folder, on: null })).toEqual({ branch: 'here', origin: 'https://example.com/here.git' });
    for (const call of calls) expect('on' in call.options).toBe(false);
  });

  test('an unreachable remote host or a missing folder shows no lines', async () => {
    // the stand-in plays a remote host that cannot be reached
    const { exec } = withRemoteHost(async () => {
      throw new Error('machine down is unreachable');
    });
    expect(await readGit({ exec }, { cwd: '/work/app', on: 'down' })).toEqual({ branch: null, origin: null });
    expect(await readGit({ exec }, { cwd: null })).toEqual({ branch: null, origin: null });
    const gone = join(tempHome(), 'gone');
    expect(await readGit({ exec }, { cwd: gone })).toEqual({ branch: null, origin: null });
  });

  test('credentials in the remote are masked', async () => {
    const folder = await repo();
    await git(folder, 'remote', 'add', 'origin', 'https://example.com/placeholder.git');
    const { exec } = recordingRun();
    const originOf = async (origin: string) => {
      await git(folder, 'remote', 'set-url', 'origin', origin);
      return (await readGit({ exec }, { cwd: folder })).origin;
    };
    // user and token, a token alone, and a password with an @ in it: the whole userinfo goes
    expect(await originOf('https://user:token@host.example/org/repo.git')).toBe('https://***@host.example/org/repo.git');
    expect(await originOf('https://ghp_secret@host.example/org/repo.git')).toBe('https://***@host.example/org/repo.git');
    expect(await originOf('http://user:p@ss@host.example:8080/org/repo.git')).toBe('http://***@host.example:8080/org/repo.git');
    expect(await originOf('ftps://user:token@host.example/repo.git')).toBe('ftps://***@host.example/repo.git');
    // a bare user name is not a secret, and a remote without credentials is shown as it is
    expect(await originOf('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git');
    expect(await originOf('ssh://git@host.example/org/repo.git')).toBe('ssh://git@host.example/org/repo.git');
    expect(await originOf('https://host.example/org/repo.git')).toBe('https://host.example/org/repo.git');
    // an @ after the host is part of the path, not credentials
    expect(await originOf('https://host.example/org/user@repo.git')).toBe('https://host.example/org/user@repo.git');
  });
});
