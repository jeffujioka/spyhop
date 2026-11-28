// The catch-up reads another Orca host's session files compressed with `zstd` when the host has
// it, raw otherwise. A test has no other host, so it stands in for `orca` and `ssh` only
// (test/helpers/stand-ins.ts): `ssh <alias>` runs its command here under that host's own home
// folder, with this Mac's `zstd`, or with none for a host the test names. The worker, the store,
// `zstd` and every other program are the real ones.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempHome } from '../helpers/files.ts';
import { rangeOf } from '../helpers/history.ts';
import { ompSession, spent } from '../helpers/live.ts';
import { DEVBOX_LISTS, environmentListOf, hostListOf } from '../helpers/orca-answers.ts';
import { figure } from '../helpers/markup.ts';
import { readOnlyLine } from '../helpers/read-only.ts';

// The line that runs a program on a host with `zstd`, its output compressed.
const ZSTD_PIPE = `'sh' '-c' '"$@" | zstd -q -c' 'sh'`;

// The Spend tab of Day once the first catch-up has read an omp session of 1.00 USD today on the
// SSH host `alias`, the only other Orca host, listed by `lists`, and the commands run on it.
async function oneDollarOn(alias: string, lists: Record<string, string>, noZstd: string[] = []) {
  const remoteHome = tempHome();
  const { html, calls } = await rangeOf([], {
    tab: 'spend',
    range: 'day',
    homes: { [alias]: remoteHome },
    orca: lists,
    noZstd,
    prepare: () => ompSession(remoteHome, join(remoteHome, 'api'), { title: 'api', calls: [spent(1)] }),
  });
  return { html, lines: calls.ssh().map((args) => ({ alias: args[0], line: args.at(-1)! })) };
}

test('Host with zstd', async () => {
  assert.doesNotThrow(() => execFileSync('zstd', ['-V'], { stdio: 'ignore' }), 'this Mac has no zstd');

  const { html, lines } = await oneDollarOn('devbox', DEVBOX_LISTS);

  const reads = lines.filter(({ line }) => line.includes('.jsonl') && !line.includes("'find'")).map(({ line }) => line);
  assert.ok(reads.length > 0 && reads.every((line) => line.startsWith(`${ZSTD_PIPE} 'dd'`) || line.startsWith(`${ZSTD_PIPE} 'tail'`)), JSON.stringify(reads));
  assert.deepEqual(lines.filter(({ alias, line }) => alias !== 'devbox' || !readOnlyLine(line)), []);
  assert.equal(figure(html, 'cost'), '$1.00');
});

test('Host without zstd', async () => {
  const oldbox = { kind: 'ssh', name: 'oldbox', id: 'oldbox', selector: '--host ssh:oldbox', connected: true };
  const lists = { 'host list --json': hostListOf(oldbox), 'environment list --json': environmentListOf() };

  const { html, lines } = await oneDollarOn('oldbox', lists, ['oldbox']);

  const probe = lines.findIndex(({ line }) => line === "'zstd' '-V'");
  assert.ok(probe >= 0, JSON.stringify(lines));
  const after = lines.slice(probe + 1).map(({ line }) => line);
  assert.deepEqual(after.filter((line) => line.includes('zstd')), []);
  assert.ok(after.some((line) => line.includes('.jsonl') && (line.startsWith("'dd'") || line.startsWith("'tail'"))), JSON.stringify(after));
  assert.equal(figure(html, 'cost'), '$1.00');
});
