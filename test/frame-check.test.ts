// The frame check `scripts/frame-check.sh`, which runs the Live panel in the Orca app on this
// computer: with `--dry-run` it prints each of its `orca` command lines, in order, and runs none.
// The stand-in `orca` (test/helpers/stand-ins.ts) logs every call, so a call would show; it fails
// each command line it has no answer for, so the script stops at the first step it has none for.
// The steps after the panel's refresh wait (the shots, the logs) are not run here, as no test
// waits on a clock.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempHome } from './helpers/files.ts';
import { answer, standIns } from './helpers/stand-ins.ts';

// The steps before the session step, answered as Orca does, with the fleet answer `fleet`.
const answeredUpToFleet = (fleet: unknown) => ({
  'plugin validate . --json': answer({}),
  'plugin check . --json': answer({ panels: [] }),
  'plugin dev watch . --json': JSON.stringify({ type: 'loaded' }),
  'plugin restart local.spyhop --json': answer({}),
  'plugin open local.spyhop --panel spyhop': '',
  'plugin dev request . spyhop.fleet --data {"request":1} --json': answer({ result: fleet }),
});

// A fleet answer with one group of the cards `ids`.
const fleetListing = (ids: string[]) => ({
  request: 1,
  groups: [{ id: 'local', name: 'local', count: ids.length, cards: ids.map((id) => ({ id })) }],
  counts: {},
  burn: {},
  attention: [],
});

// Runs the script from a copy in a temporary folder, so that what it records under
// `.orca/shots/` stays out of this one.
function frameCheck() {
  const folder = tempHome();
  mkdirSync(join(folder, 'scripts'));
  copyFileSync(new URL('../scripts/frame-check.sh', import.meta.url), join(folder, 'scripts', 'frame-check.sh'));
  return spawnSync('bash', [join(folder, 'scripts', 'frame-check.sh')], { encoding: 'utf8' });
}

test('the whole-panel steps are listed', () => {
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
    'plugin restart local.spyhop --json',
    'plugin open local.spyhop --panel spyhop',
    'plugin dev request . spyhop.fleet --data {"request":1} --json',
    'plugin dev request . spyhop.session --data {"request":2,"card":"<id>"} --json',
    'plugin dev request . spyhop.range --data {"request":3,"tab":"spend","range":"day"} --json',
    'plugin dev request . spyhop.range --data {"request":3,"tab":"spend","range":"year"} --json',
    'plugin shot local.spyhop --panel spyhop --width 300 --theme dark --json',
    'plugin shot local.spyhop --panel spyhop --width 300 --theme light --json',
    'plugin shot local.spyhop --panel spyhop --width 420 --theme dark --json',
    'plugin shot local.spyhop --panel spyhop --width 420 --theme light --json',
    'plugin logs local.spyhop --json',
    'plugin dev unload . --json',
  ]);
  assert.deepEqual(orca.orca(), []);
});

test('the insights steps are listed', () => {
  const orca = standIns({ homes: {}, orca: {} });

  // throws when the script exits with anything but 0
  const out = execFileSync('bash', ['scripts/frame-check.sh', '--dry-run'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });

  const lines = out.split('\n');
  const step = `+ ${process.env.ORCA_CLI_COMMAND} `;
  for (const line of [
    `${step}plugin dev request . spyhop.range --data {"request":3,"tab":"spend","range":"day"} --json`,
    `${step}plugin dev request . spyhop.range --data {"request":3,"tab":"spend","range":"year"} --json`,
    `+ test -s ${process.env.HOME}/.local/state/spyhop/insights.db`,
  ]) {
    assert.ok(lines.includes(line), `${line}\nnot in\n${out}`);
  }
  // the catch-ups are counted before the dev plugin is loaded, so that only one of its own counts
  const counted = lines.indexOf(`+ sqlite3 -readonly ${process.env.HOME}/.local/state/spyhop/insights.db "SELECT value FROM meta WHERE key = 'catch-ups'"`);
  assert.ok(counted >= 0 && counted < lines.indexOf(`${step}plugin dev watch . --json`), out);
  assert.deepEqual(orca.orca(), []);
});

test('a computer without sqlite3 fails before any step', () => {
  const orca = standIns({ homes: {}, orca: {} });
  // a PATH of `dirname` alone, which the script runs before it looks for `sqlite3`
  const bin = tempHome();
  symlinkSync(execFileSync('/bin/sh', ['-c', 'command -v dirname'], { encoding: 'utf8' }).trim(), join(bin, 'dirname'));

  const run = spawnSync('/bin/bash', ['scripts/frame-check.sh'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, PATH: bin } });

  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('frame check: sqlite3 is not installed'), run.stderr);
  assert.deepEqual(orca.orca(), []);
});

test('a failing step prints its answer', () => {
  // the stand-in answers no command line: each fails with its error envelope, as Orca's `orca` does
  standIns({ homes: {}, orca: {} });

  const run = spawnSync('bash', ['scripts/frame-check.sh'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });

  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('{"ok":false,"error":{"code":"not_found"}}'), run.stderr);
});

test('a card that left Orca is passed over', () => {
  const orca = standIns({
    homes: {},
    orca: {
      ...answeredUpToFleet(fleetListing(['gone', 'next'])),
      'plugin dev request . spyhop.session --data {"request":2,"card":"gone"} --json': answer({ result: { request: 2, session: null } }),
      'plugin dev request . spyhop.fleet --data {"request":3} --json': answer({ result: fleetListing(['next']) }),
    },
  });

  const run = frameCheck();

  assert.ok(run.stdout.includes('frame check: "gone" left Orca during the check'), run.stdout);
  // the next card is asked for, and the stand-in has no answer for it
  assert.ok(orca.orca().includes('plugin dev request . spyhop.session --data {"request":2,"card":"next"} --json'));
  assert.equal(run.status, 1);
});

// A card's id joins its parts with NUL characters, as the worker makes it (src/agent-cards.ts).
test('a null session of a card still listed fails', () => {
  const orca = standIns({
    homes: {},
    orca: {
      ...answeredUpToFleet(fleetListing(['kept\0/home/a.jsonl', 'next'])),
      'plugin dev request . spyhop.session --data {"request":2,"card":"kept\\u0000/home/a.jsonl"} --json': answer({ result: { request: 2, session: null } }),
      'plugin dev request . spyhop.fleet --data {"request":3} --json': answer({ result: fleetListing(['kept\0/home/a.jsonl', 'next']) }),
    },
  });

  const run = frameCheck();

  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('frame check: the session answer of "kept\\u0000/home/a.jsonl" is null while the fleet still lists it'), run.stderr);
  assert.ok(!orca.orca().some((line) => line.includes('"card":"next"')));
});
