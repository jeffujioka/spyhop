// The runner on another Orca host: each program a fresh `ssh <alias>`, at most four at once per
// alias so an SSH server's limit on new connections is not crossed, giving up a connection after
// 5 s, reusing one connection per alias when the alias's own ssh settings do not, and never
// reading an alias as an ssh option. `ssh` is the stand-in of test/helpers/stand-ins.ts, which
// runs the command here; every other program is real.
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/exec.ts';
import { tempHome } from './helpers/files.ts';
import { standIns } from './helpers/stand-ins.ts';

test('At most four programs at once on one host', async () => {
  const running = join(tempHome(), 'running');
  mkdirSync(running);
  const calls = standIns({ homes: { box: tempHome() }, orca: {} });

  // each program counts the others running, then runs a while
  const script = 'ls "$0" | wc -l; touch "$0/$1"; sleep 0.3; rm "$0/$1"';
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => run('sh', ['-c', script, running, String(i)], { on: 'box' })));

  assert.deepEqual(
    results.map((result) => result.code),
    Array(8).fill(0),
  );
  const most = Math.max(...results.map((result) => Number(result.stdout.trim())));
  assert.ok(most <= 3, `${most + 1} programs at once`);
  assert.deepEqual(calls.ssh()[0].slice(0, 6), ['box', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--']);
});

test('An alias that reads as an ssh option is refused', async () => {
  const calls = standIns({ homes: {}, orca: {} });

  const result = await run('uname', ['-s'], { on: '-oProxyCommand=touch /tmp/x' });

  assert.notEqual(result.code, 0);
  assert.deepEqual(calls.ssh(), []);
});

// spyhop's options for reusing connections
const REUSE = ['ControlMaster=auto', `ControlPath=/tmp/spyhop-${process.getuid!()}/%C`, 'ControlPersist=60'];
// the options of an ssh call that set connection reuse
const reuseOptions = (args: string[]) => args.filter((arg) => /^Control(Master|Path|Persist)=/.test(arg));

// `ssh -G` is read at most once a minute per alias for this process, so each test has its own alias.

test('Alias that already reuses connections', async () => {
  // `ssh -G` prints `controlmaster yes` as `true`
  const controlmaster = { 'devbox-reuses': 'auto', 'devbox-yes': 'true' };
  const calls = standIns({ homes: { 'devbox-reuses': tempHome(), 'devbox-yes': tempHome() }, orca: {}, controlmaster });

  const results = [await run('uname', ['-s'], { on: 'devbox-reuses' }), await run('uname', ['-s'], { on: 'devbox-yes' })];

  assert.deepEqual(
    results.map((result) => result.code),
    [0, 0],
  );
  assert.deepEqual(calls.sshSettings(), ['devbox-reuses', 'devbox-yes']);
  assert.deepEqual(
    calls.ssh(),
    ['devbox-reuses', 'devbox-yes'].map((alias) => [alias, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', "'uname' '-s'"]),
  );
});

test('Alias that does not reuse connections', async () => {
  const calls = standIns({ homes: { devbox: tempHome() }, orca: {}, controlmaster: { devbox: 'no' } });

  const results = [await run('uname', ['-s'], { on: 'devbox' }), await run('printenv', ['HOME'], { on: 'devbox' })];

  assert.deepEqual(
    results.map((result) => result.code),
    [0, 0],
  );
  assert.deepEqual(
    calls.ssh().map((args) => [args[0], reuseOptions(args)]),
    [
      ['devbox', REUSE],
      ['devbox', REUSE],
    ],
  );
  assert.equal(statSync(`/tmp/spyhop-${process.getuid!()}`).mode & 0o777, 0o700);
  assert.deepEqual(calls.sshSettings(), ['devbox']);
});

test('ssh -G fails', async () => {
  const home = tempHome();
  const calls = standIns({ homes: { 'devbox-unread': home }, orca: {} });

  const result = await run('printenv', ['HOME'], { on: 'devbox-unread' });

  assert.deepEqual(calls.sshSettings(), ['devbox-unread']);
  assert.deepEqual(calls.ssh().map(reuseOptions), [[]]);
  assert.deepEqual(result, { code: 0, stdout: `${home}\n`, stderr: '' });
});

test('A socket folder that is a symlink is not used', async (t) => {
  // a symlink in the socket folder's place, as another local user could leave one, to a folder
  // of this user's; here the symlink is this user's own, so only its being a symlink refuses it.
  // A socket folder already there is moved aside for the test and put back after it, its live
  // sockets kept.
  const folder = `/tmp/spyhop-${process.getuid!()}`;
  const saved = `${folder}.saved-${process.pid}`;
  const there = lstatSync(folder, { throwIfNoEntry: false }) !== undefined;
  if (there) renameSync(folder, saved);
  t.after(() => {
    rmSync(folder, { force: true });
    if (there) renameSync(saved, folder);
  });
  const target = tempHome();
  chmodSync(target, 0o755);
  symlinkSync(target, folder);
  const calls = standIns({ homes: { 'devbox-linked': tempHome() }, orca: {}, controlmaster: { 'devbox-linked': 'false' } });

  const result = await run('uname', ['-s'], { on: 'devbox-linked' });

  assert.equal(result.code, 0);
  assert.deepEqual(calls.ssh().map(reuseOptions), [[]]);
  assert.equal(statSync(target).mode & 0o777, 0o755);
});
