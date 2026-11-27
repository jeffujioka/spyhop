// The reads of omp sub-agent transcripts on another Orca host: read with read-only programs over
// `ssh devbox`, once whole and then only what was appended, their totals kept like those of a
// session file. A test has no SSH host, so `ssh` is stood in for (test/helpers/stand-ins.ts): it
// runs the command here under the remote host's own home folder and logs it; every program it
// runs is real. A card's cost is read as the card writes it, with its sub-agents'.
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentCards } from '../src/agent-cards.ts';
import { cardView } from '../src/card-view.ts';
import { decodeScans, encodeScans } from '../src/core/refresh.js';
import { run } from '../src/exec.ts';
import { NOW, PADDING, agent, costOf, costTurn, ompSessionOf, subAgentFile } from './helpers/agent-cards.ts';
import { useTempHome } from './helpers/env.ts';
import { tempHome } from './helpers/files.ts';
import { readOnlyLine } from './helpers/read-only.ts';
import { standIns } from './helpers/stand-ins.ts';

// An omp Orca agent on the SSH target `devbox`, whose session has logged 0.10 USD, with a
// sub-agent `Impl<n>` for each of `costs` that has logged it, after PADDING when `large`: the
// sub-agents' transcripts, the session's sub-agent folder, the command lines `ssh devbox` has
// run so far, and `build`, which builds the agent's card with `cards` (a new builder when not
// given) and gives it with its cost as the card writes it.
function devboxAgent(costs: number[], { large = false } = {}) {
  useTempHome();
  const remoteHome = tempHome();
  const path = join(remoteHome, 'work/infra-main');
  const file = ompSessionOf(remoteHome, path);
  const transcripts = costs.map((usd, i) =>
    subAgentFile(file, `Impl${i + 1}`, [costTurn(usd), ...(large ? [PADDING] : [])]),
  );
  const calls = standIns({ homes: { devbox: remoteHome }, orca: {} });
  const lines = () =>
    calls
      .ssh()
      .filter(([alias]) => alias === 'devbox')
      .map((args) => args.at(-1)!);
  const agents = [agent({ machine: 'devbox', sessionId: 's1', path })];
  const home = tempHome();
  const builder = createAgentCards({ run, home });
  const build = async (cards = builder) => {
    const [card] = await cards.build(agents, NOW);
    return { card, cost: costOf(cardView(card, { home, pane: null, now: NOW })) };
  };
  return { transcripts, folder: file.replace(/\.jsonl$/, ''), lines, ssh: calls.ssh, build, builder, home };
}

// Which of `lines` read the file `path` from its start with `dd`.
const ddsOf = (lines: string[], path: string) => lines.filter((line) => line.startsWith(`'dd' 'if=${path}' `));

test('Sub-agents read with read-only programs', async () => {
  const { ssh, build } = devboxAgent([0.2, 0.3]);

  const { cost } = await build();

  assert.equal(cost, '$0.60');
  assert.ok(ssh().length > 0);
  assert.deepEqual(
    ssh().filter((args) => args[0] !== 'devbox' || !readOnlyLine(args.at(-1)!)),
    [],
  );
});

test('Ended sub-agents cost one listing', async () => {
  const { transcripts, folder, lines, build } = devboxAgent([0.2, 0.3, 0.4]);
  const { card: first } = await build();
  assert.deepEqual([first.subAgents!.total, first.subAgents!.read], [3, 3]);
  const before = lines().length;

  const { cost } = await build();

  const ran = lines().slice(before);
  assert.equal(ran.filter((line) => line.startsWith(`'find' '-H' '${folder}' `)).length, 1);
  assert.deepEqual(
    ran.filter((line) => transcripts.some((transcript) => line.includes(transcript))),
    [],
  );
  assert.equal(cost, '$1.00');
});

test('a failed sub-agent listing keeps the sub-agents listed before', async () => {
  const { folder, build } = devboxAgent([0.2, 0.3]);
  assert.equal((await build()).card.subAgents!.total, 2);
  // a folder `find` cannot list: it exits non-zero, as when the connection drops
  chmodSync(folder, 0o000);
  try {
    const { card, cost } = await build();

    assert.deepEqual(card.subAgents!.agents.map(({ name }) => name).sort(), ['Impl1', 'Impl2']);
    assert.equal(cost, '$0.60');
    // a builder that never listed the folder knows no sub-agents
    assert.equal((await build(createAgentCards({ run, home: tempHome() }))).card.subAgents, null);
  } finally {
    chmodSync(folder, 0o755);
  }
});

test('Appended sub-agent transcript is read from where it ended', async () => {
  const { transcripts, lines, build } = devboxAgent([0.2], { large: true });
  const [transcript] = transcripts;
  assert.equal((await build()).cost, '$0.30');
  assert.equal(ddsOf(lines(), transcript).length, 1);
  const pos = statSync(transcript).size;
  appendFileSync(transcript, costTurn(0.1));
  const before = lines().length;

  const { cost } = await build();

  const ran = lines().slice(before);
  assert.ok(ran.includes(`'tail' '-c' '+${pos}' '--' '${transcript}'`), ran.join('\n'));
  assert.deepEqual(ddsOf(ran, transcript), []);
  assert.equal(cost, '$0.40');
});

test('Sub-agent totals survive a restart of the worker', async () => {
  const { transcripts, lines, build, builder, home } = devboxAgent([0.2], { large: true });
  await build();
  // what the worker writes to the plugin's storage, and a new worker's builder made from it
  const stored = JSON.parse(JSON.stringify(encodeScans(builder.scanned().scans)));
  const restarted = createAgentCards({ run, home, kept: decodeScans(stored) });
  const before = lines().length;

  const { cost } = await build(restarted);

  assert.deepEqual(ddsOf(lines().slice(before), transcripts[0]), []);
  assert.equal(cost, '$0.30');
});
