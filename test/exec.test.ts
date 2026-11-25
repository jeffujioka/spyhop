// The runner on another Orca host: each program a fresh `ssh <alias>`, at most four at once per
// alias so an SSH server's limit on new connections is not crossed, giving up a connection after
// 5 s, and never reading an alias as an ssh option. `ssh` is the stand-in of
// test/helpers/stand-ins.ts, which runs the command here; every other program is real.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
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
