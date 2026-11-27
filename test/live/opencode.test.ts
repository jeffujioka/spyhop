// opencode on the card and the session screen: Orca's two agent kinds of opencode, and sessions
// read from the current tables of opencode's database, from the legacy ones, and from the current
// ones when a session is in both, made from test/fixtures/opencode/current.sql (basic.sql for the
// legacy tables alone) and read by the real sqlite3 through the real runner (`cardsOf`,
// `sessionOf`). And a session's window, from opencode's model catalogue
// (test/fixtures/opencode/models.json, shaped on this Mac's ~/.cache/opencode/models.json) on the
// session's host, this computer or the SSH target `devbox`, which the stand-in `ssh` reaches
// (test/helpers/stand-ins.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentCards } from '../../src/agent-cards.ts';
import { cardView } from '../../src/card-view.ts';
import { formatCost } from '../../src/core/format.js';
import { CATALOGUE_TTL_MS } from '../../src/core/providers/opencode-sources.js';
import { createTtlCache } from '../../src/core/ttl-cache.js';
import { run } from '../../src/exec.ts';
import { NOW, agent, cardsOf, costOf, opencodeCalls, type OpencodeCalls, opencodeCatalogue, opencodeDatabase, workspace } from '../helpers/agent-cards.ts';
import { tempHome } from '../helpers/files.ts';
import { fleetOf, sessionOf } from '../helpers/live.ts';
import { figure, parts, text } from '../helpers/markup.ts';
import { DEVBOX, DEVBOX_LISTS } from '../helpers/orca-answers.ts';
import { readOnlyLine } from '../helpers/read-only.ts';
import { standIns } from '../helpers/stand-ins.ts';

test('Agent of the kind opencode2', async () => {
  const home = tempHome();
  opencodeDatabase(home, 'current');

  // ses_current is the session of the folder /work/current
  const [{ view }] = await cardsOf(home, [agent({ agent: 'opencode2', path: '/work/current' })]);

  assert.equal(view.harness, 'opencode');
  assert.equal(view.model, 'claude-haiku-5.5');
  assert.equal(costOf(view), '$0.44');
});

test('Session in the current tables', async () => {
  const home = tempHome();
  opencodeDatabase(home, 'current');

  // ses_current is in `session_v2` and `session_message` only
  const [{ view }] = await cardsOf(home, [agent({ agent: 'opencode', path: '/work/current' })]);

  assert.equal(view.model, 'claude-haiku-5.5');
  assert.equal(costOf(view), '$0.44');
});

test('Session only in the legacy tables', async () => {
  const home = tempHome();
  opencodeDatabase(home, 'current');

  // ses_legacy is in `session`, `message` and `part` only, of a database that has the current
  // tables too
  const [{ view }] = await cardsOf(home, [agent({ agent: 'opencode', path: '/work/legacy' })]);

  assert.equal(costOf(view), '$0.10');
});

test('Session in both generations of tables', async () => {
  const home = tempHome();
  opencodeDatabase(home, 'current');

  // ses_both logs 0.44 in the current tables and 0.10 in the legacy ones
  const [{ view }] = await cardsOf(home, [agent({ agent: 'opencode', sessionId: 'ses_both', path: '/work/both' })]);

  assert.equal(costOf(view), '$0.44');
});

test('Database with only the current tables', async () => {
  const home = tempHome();
  const database = opencodeDatabase(home, 'current');
  // a database of an opencode that never had, or has dropped, `session`, `message` and `part`
  execFileSync('sqlite3', [database, 'DROP TABLE part; DROP TABLE message; DROP TABLE session;']);

  // the first agent links by its folder, the second by the session it names
  const cards = await cardsOf(home, [agent({ id: 'o1', agent: 'opencode', path: '/work/current' }), agent({ id: 'o2', agent: 'opencode', sessionId: 'ses_logged', path: '/work/elsewhere' })]);

  assert.deepEqual(
    cards.map(({ card, view }) => [card.id, view.model, costOf(view)]),
    [
      ['o1', 'claude-haiku-5.5', '$0.44'],
      ['o2', 'claude-haiku-5.5', '$0.50'],
    ],
  );
});

test('Failed tool call of an opencode session', async () => {
  const { html } = await sessionOf([{ project: 'web', name: 'main', agents: ['working'], harness: 'opencode', sessionId: 'ses_current' }], {
    prepare: (home) => opencodeDatabase(home, 'current'),
  });

  const [section] = parts(html, 'data-part', 'tools');
  assert.equal(text(parts(section, 'class', 'row head')[0]), 'Tools 4 tool calls · 1 failed');
  assert.deepEqual(parts(section, 'class', 'row item').map(text), ['bash 4 1 failed']);
});

test('Agents of both opencode kinds in one folder link as one harness', async () => {
  const home = tempHome();
  opencodeDatabase(home);

  // basic.sql's sessions of /work/demo: ses_basic, the newest, logs $0.41; ses_old no message.
  // o1 names ses_basic, so o2, which names none, links the newest session no agent named.
  const cards = await cardsOf(home, [
    agent({ id: 'o1', agent: 'opencode', sessionId: 'ses_basic', path: '/work/demo' }),
    agent({ id: 'o2', agent: 'opencode2', path: '/work/demo' }),
  ]);

  assert.deepEqual(
    cards.map(({ card, view }) => [card.id, card.agents, costOf(view)]),
    [
      ['o1', ['o1'], '$0.41'],
      ['o2', ['o2'], 'n/a'],
    ],
  );
});

test('Session total opencode logged above its model calls', async () => {
  // ses_logged's `session_v2.cost` is 0.50, its rows log 0.30 and 0.14
  const { answer, fleet } = await sessionOf([{ project: 'web', name: 'main', agents: ['working'], harness: 'opencode', sessionId: 'ses_logged' }], {
    prepare: (home) => opencodeDatabase(home, 'current'),
  });

  // the card, the figures and the cost card read opencode's own total
  assert.equal(formatCost(fleet.groups[0].cards[0].cost), '$0.50');
  assert.equal(formatCost(answer.session.figures.cost), '$0.50');
  assert.ok(answer.session.cost && answer.session.cost.total === 0.5);
  // the cost chart adds up the model calls, so it ends below that total
  assert.ok(answer.session.cost.own !== 'n/a');
  assert.equal(formatCost(answer.session.cost.own.at(-1)!.v), '$0.44');
});

test('Child sessions of an opencode session', async () => {
  // ses_p costs 1.00; ses_c, whose parent is ses_p, 0.40; ses_g, whose parent is ses_c, 0.10
  const { html } = await sessionOf([{ project: 'web', name: 'main', agents: ['working'], harness: 'opencode', sessionId: 'ses_p' }], {
    prepare: (home) => opencodeDatabase(home, 'current'),
  });

  assert.equal(figure(html, 'cost'), '$1.50');
  const [section] = parts(html, 'data-part', 'subagents');
  assert.equal(text(parts(section, 'class', 'row head')[0]), 'Sub-agents 2 in total · $0.50');
  assert.deepEqual(parts(section, 'data-figure', 'running'), []);
  // ses_g's row names no model, so its last message's is shown
  assert.deepEqual(
    parts(section, 'data-agent').map((bar) => text(parts(bar, 'class', 'row label')[0])),
    ['Explore the repo · general · claude-haiku-5.5 · $0.40', 'Read the docs · explore · claude-haiku-5.5 · $0.10'],
  );
});

test('Child sessions of a legacy opencode session', async () => {
  // ses_legacy_p costs 0.10, and ses_legacy_c, whose parent it is, 0.05, in a legacy `session`
  // without the `agent` and `model` columns
  const { html } = await sessionOf([{ project: 'web', name: 'main', agents: ['working'], harness: 'opencode', sessionId: 'ses_legacy_p' }], {
    prepare: (home) => opencodeDatabase(home, 'current'),
  });

  assert.equal(figure(html, 'cost'), '$0.15');
  const [section] = parts(html, 'data-part', 'subagents');
  assert.equal(text(parts(section, 'class', 'row head')[0]), 'Sub-agents 1 in total · $0.05');
  const labels = parts(section, 'data-agent').map((bar) => text(parts(bar, 'class', 'row label')[0]));
  assert.equal(labels.length, 1);
  assert.match(labels[0], /^Fix the build · .* · model-a · \$0\.05$/);
});

// Four model calls whose context rises to 160,000 tokens, of `model` of `provider`.
const rising = (provider: string, model: string): OpencodeCalls => ({ provider, model, contexts: [40_000, 80_000, 120_000, 160_000] });

// The fleet card of a working opencode agent of the workspace `web`/`main` on this computer, or of
// `infra`/`main` on `devbox` with `remote` its home, whose session's calls are `calls`; the
// catalogue is under the agent's host's home when `catalogue`.
async function opencodeCard({ calls, catalogue, remote }: { calls: OpencodeCalls; catalogue: boolean; remote?: string }) {
  const on = remote ? { project: 'infra', name: 'main', hostId: `ssh:${DEVBOX}` } : { project: 'web', name: 'main' };
  const { html } = await fleetOf([{ ...on, agents: ['working'], harness: 'opencode' }], {
    ...(remote ? { homes: { devbox: remote }, orca: DEVBOX_LISTS } : {}),
    prepare: (home) => {
      const host = remote ?? home;
      opencodeCalls(host, workspace(home, `${on.project}-${on.name}`), calls);
      if (catalogue) opencodeCatalogue(host);
    },
  });
  return parts(html, 'data-part', 'card')[0];
}

// A card of a session without a window: the tokens used, the spark line and the cost, and no
// percent, window or bar.
function assertNoWindow(card: string) {
  assert.equal(figure(card, 'tokens'), '160k');
  assert.match(parts(card, 'data-chart', 'spark')[0], /^<svg[^>]* data-points="4"/);
  assert.equal(figure(card, 'percent'), undefined);
  assert.equal(figure(card, 'window'), undefined);
  assert.deepEqual(parts(card, 'data-part', 'bar'), []);
  assert.equal(figure(card, 'cost'), '$0.40');
}

test('Model in the catalogue', async () => {
  const card = await opencodeCard({ calls: rising('github-copilot', 'claude-haiku-5.5'), catalogue: true });

  assert.equal(figure(card, 'percent'), '80%');
  assert.match(text(card), /160k \/ 200k/);
  assert.match(parts(card, 'data-part', 'bar')[0], /^<[^>]* class="[^"]*\blvl-hot\b/);
  // the attention list's context row comes with task 5.3; until then the card is what is read
});

test('Model missing from the catalogue', async () => {
  const card = await opencodeCard({ calls: rising('github-copilot', 'claude-haiku-9'), catalogue: true });

  assertNoWindow(card);
});

test('Catalogue missing', async () => {
  const card = await opencodeCard({ calls: rising('github-copilot', 'claude-haiku-5.5'), catalogue: false, remote: tempHome() });

  assertNoWindow(card);
});

// The commands the stand-ins' `ssh` ran on `devbox` that read the catalogue under `home`, each its
// arguments; the home tells them from the reads of any other test's host.
const catalogueReadsIn = ({ ssh }: { ssh: () => string[][] }, home: string) =>
  ssh().filter((args) => args[0] === 'devbox' && args.at(-1)!.includes(`${home}/.cache/opencode/models.json`));

// A card builder over the opencode agent of `/work/window` on `devbox`, whose home `remote` holds
// the catalogue and the session of `folder`, as the worker keeps one from refresh to refresh:
// `refresh(now)` is a refresh at `now`, and gives the card's view; `catalogueReads()`, the
// catalogue reads the stand-in `ssh` ran (see catalogueReadsIn).
function devboxRefreshes({ folder = '/work/window' } = {}) {
  const remote = tempHome();
  opencodeCalls(remote, folder, rising('github-copilot', 'claude-haiku-5.5'));
  opencodeCatalogue(remote);
  const calls = standIns({ homes: { devbox: remote }, orca: {} });
  const home = tempHome();
  const cards = createAgentCards({ run, home });
  const agents = [agent({ agent: 'opencode', path: '/work/window', machine: 'devbox' })];
  const refresh = async (now: number) => (await cards.build(agents, now)).map((card) => cardView(card, { home, pane: null, now }))[0];
  return { refresh, remote, catalogueReads: () => catalogueReadsIn(calls, remote) };
}

test('Catalogue read with a read-only program', async () => {
  const { refresh, catalogueReads } = devboxRefreshes();

  const view = await refresh(NOW);

  const reads = catalogueReads();
  assert.equal(reads.length, 1);
  assert.ok(readOnlyLine(reads[0].at(-1)!), reads[0].at(-1));
  assert.equal(view.context.window, 200_000);
  assert.equal(view.context.percent, 0.8);
});

test('Catalogue read again at most once an hour', async () => {
  const minute = 60_000;
  const { refresh, catalogueReads } = devboxRefreshes();
  await refresh(NOW);
  assert.equal(catalogueReads().length, 1);

  // refreshes over the next 59 minutes read no catalogue
  for (let at = 10; at < 60; at += 10) await refresh(NOW + at * minute);
  const last = await refresh(NOW + 59 * minute);
  assert.equal(catalogueReads().length, 1);
  assert.equal(last.context.percent, 0.8);

  // the refresh 2 minutes later, past CATALOGUE_TTL_MS, reads it again
  assert.ok(61 * minute >= CATALOGUE_TTL_MS);
  await refresh(NOW + 61 * minute);
  assert.equal(catalogueReads().length, 2);
});

test('Catalogue read again after an ssh failure', async () => {
  // a refresh before the session is of the agent's folder: `devbox`'s place is known, and no
  // session is read
  const { refresh, remote, catalogueReads } = devboxRefreshes({ folder: '/work/before' });
  assert.equal((await refresh(NOW)).cost, 'n/a');
  assert.equal(catalogueReads().length, 0);
  const database = join(remote, '.local/share/opencode/opencode.db');
  execFileSync('sqlite3', [database, "UPDATE session_v2 SET directory = '/work/window' WHERE id = 'ses_window'"]);

  // a refresh whose catalogue read finds `devbox` gone: the host answers the session's change
  // check, held until it has started, and is gone when the read starts, so ssh exits 255 there
  const linking = standIns({ homes: { devbox: remote }, orca: {}, held: ['ssh devbox'] });
  const first = refresh(NOW + 1000);
  await linking.until(() => linking.ssh().some((args) => args[0] === 'devbox' && args.at(-1)!.includes('/work/window')));
  const gone = standIns({ homes: {}, orca: {} });
  linking.release('ssh devbox');
  const failed = await first;
  assert.equal(catalogueReadsIn(gone, remote).length, 1);
  assert.equal(failed.context.window, 'n/a');

  // `devbox` answers again: a refresh well within CATALOGUE_TTL_MS reads the catalogue again
  const back = standIns({ homes: { devbox: remote }, orca: {} });
  const view = await refresh(NOW + 60_000);
  assert.equal(catalogueReadsIn(back, remote).length, 1);
  assert.equal(view.context.percent, 0.8);
});

test('Failed load not kept', async () => {
  // a load that rejects, as the read of a catalogue on a host ssh cannot reach does, is asked
  // again at the next call; one that resolves is kept
  const cached = createTtlCache(CATALOGUE_TTL_MS);
  let loads = 0;
  const failing = () => {
    loads += 1;
    return Promise.reject(new Error('ssh failed'));
  };
  await assert.rejects(cached('devbox', NOW, failing));
  await assert.rejects(cached('devbox', NOW + 1, failing));
  assert.equal(loads, 2);
  assert.equal(await cached('devbox', NOW + 2, async () => 'read'), 'read');
  assert.equal(await cached('devbox', NOW + 3, async () => 'again'), 'read');
});
