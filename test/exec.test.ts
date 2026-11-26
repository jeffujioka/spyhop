// The runner on another Orca host: each program a fresh `ssh <alias>`, giving up a connection
// after 5 s, reusing one connection per alias when the alias's own ssh settings do not, at most
// eight at once on an alias whose connection is spyhop's own and four on any other, and never
// reading an alias as an ssh option. `ssh` is the stand-in of test/helpers/stand-ins.ts, which
// runs the command here; every other program is real.
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { watch } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/exec.ts';
import { tempHome } from './helpers/files.ts';
import { standIns } from './helpers/stand-ins.ts';

// A program that runs until the test releases it: it leaves a file named after itself in its
// host's `running` folder as it starts, ends once the host's home holds `release`, and prints
// its name.
const UNTIL_RELEASED = 'touch "$HOME/running/$0"; until [ -e "$HOME/release" ]; do sleep 0.01; done; echo "$0"';

// Asks for 12 such programs on an alias, whose home is `home`.
function twelve(alias: string, home: string) {
  mkdirSync(join(home, 'running'));
  return Array.from({ length: 12 }, (_, i) => run('sh', ['-c', UNTIL_RELEASED, `${alias}-${i}`], { on: alias }));
}

// How many of a host's programs run at once before the release: the files in `running` once
// `count` of them are there (or, should they never be, 5 s have passed) and one more program,
// asked for only then on the alias `elsewhere`, has ended, so that a program over `count` had
// the time to start too.
async function atOnce(home: string, count: number) {
  const folder = join(home, 'running');
  const changes = watch(folder, { signal: AbortSignal.timeout(5000) });
  try {
    while (readdirSync(folder).length < count) await changes.next();
  } catch {
    // the 5 s passed: the count below tells
  } finally {
    await changes.return();
  }
  await run('true', [], { on: 'elsewhere' });
  return readdirSync(folder).length;
}

// what the 12 programs of an alias print, each its own name
const outputs = (alias: string) => Array.from({ length: 12 }, (_, i) => ({ code: 0, stdout: `${alias}-${i}\n`, stderr: '' }));

// `ssh -G` is read at most once a minute per alias for this process, so each test has its own alias.

test('Eight at once on a connection spyhop owns', async () => {
  const home = tempHome();
  standIns({ homes: { 'devbox-owned': home, elsewhere: tempHome() }, orca: {}, controlmaster: { 'devbox-owned': 'no' } });

  const programs = twelve('devbox-owned', home);
  const most = await atOnce(home, 8);
  writeFileSync(join(home, 'release'), '');
  const results = await Promise.all(programs);

  assert.equal(most, 8);
  assert.deepEqual(results, outputs('devbox-owned'));
});

test('Four at once on a connection spyhop does not own', async () => {
  const homes = { 'devbox-shared': tempHome(), oldbox: tempHome(), elsewhere: tempHome() };
  standIns({ homes, orca: {}, controlmaster: { 'devbox-shared': 'auto' } });

  const programs = [...twelve('devbox-shared', homes['devbox-shared']), ...twelve('oldbox', homes.oldbox)];
  const most = [await atOnce(homes['devbox-shared'], 4), await atOnce(homes.oldbox, 4)];
  writeFileSync(join(homes['devbox-shared'], 'release'), '');
  writeFileSync(join(homes.oldbox, 'release'), '');
  const results = await Promise.all(programs);

  assert.deepEqual(most, [4, 4]);
  assert.deepEqual(results, [...outputs('devbox-shared'), ...outputs('oldbox')]);
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
