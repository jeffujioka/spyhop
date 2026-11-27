// The frame check `scripts/frame-check.sh`, which runs the Live panel in the Orca app on this
// computer: with `--dry-run` it prints each of its `orca` command lines, in order, and runs none.
// The stand-in `orca` (test/helpers/stand-ins.ts) logs every call, so a call would show; it fails
// each command line it has no answer for, so the script's first step fails when it is run.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { standIns } from './helpers/stand-ins.ts';

test('the frame check lists its steps', () => {
  const orca = standIns({ homes: {}, orca: {} });

  // throws when the script exits with anything but 0
  const out = execFileSync('bash', ['scripts/frame-check.sh', '--dry-run'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });

  const step = `+ ${process.env.ORCA_CLI_COMMAND} `;
  const steps = out
    .split('\n')
    .filter((line) => line.startsWith(step))
    .map((line) => line.slice(step.length));
  assert.deepEqual(steps, [
    'plugin validate . --json',
    'plugin check . --json',
    'plugin dev watch . --json',
    'plugin open local.spyhop --panel spyhop',
    'plugin dev request . spyhop.fleet --data {"request":1} --json',
    'plugin shot local.spyhop --panel spyhop --width 300 --json',
    'plugin shot local.spyhop --panel spyhop --width 420 --json',
    'plugin logs local.spyhop --json',
    'plugin dev unload . --json',
  ]);
  assert.deepEqual(orca.orca(), []);
});

test('a failing step prints its answer', () => {
  // the stand-in answers no command line: each fails with its error envelope, as Orca's `orca` does
  standIns({ homes: {}, orca: {} });

  const run = spawnSync('bash', ['scripts/frame-check.sh'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });

  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('{"ok":false,"error":{"code":"not_found"}}'), run.stderr);
});
