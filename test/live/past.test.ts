// The Spend tab's list of the costliest sessions and the screen of a past session, one with no Live
// card (src/live/spend.ts, src/live/session.ts): the real worker's answers from the history store,
// which its first catch-up filled from omp session files under a temporary home, drawn by the live
// panel (`openLive`, test/helpers/live.ts) and read through the markup's conventions
// (test/helpers/markup.ts).
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { RANGE_REFRESH_MS } from '../../src/core/refresh.js';
import { NOW, workspace } from '../helpers/agent-cards.ts';
import { tempHome } from '../helpers/files.ts';
import { DEVBOX, DEVBOX_LISTS } from '../helpers/orca-answers.ts';
import { caughtUp } from '../helpers/history.ts';
import { FIX, folderOf, MODEL, ompSession, ompSubAgent, openLive, spent, until } from '../helpers/live.ts';
import { attr, figure, parts, text } from '../helpers/markup.ts';
import type { HostWorkspace } from '../helpers/orca-host.ts';

const DAY = 24 * 60 * 60 * 1000;

// The panel opened on this computer's Orca host with `workspaces` and the files `prepare` writes
// under its home, once its first catch-up has read them: `home`, and the panel with the tab Spend
// shown over `range`.
async function spendOf(range: 'week' | 'month', prepare: (home: string) => void, workspaces: HostWorkspace[] = []) {
  let home = '';
  const opened = await openLive(workspaces, {
    prepare: (made) => {
      home = made;
      prepare(made);
    },
  });
  await caughtUp(home);
  await opened.openTab('spend', range);
  return { ...opened, home };
}

// The rows of the costliest sessions of the Spend tab `html`: each one's title, repo, harness, host
// and cost as drawn.
const costliestOf = (html: string) =>
  parts(parts(html, 'data-list', 'costliest')[0] ?? '', 'data-part', 'costly').map((row) => ({
    title: text(parts(row, 'class', 'title grow')[0]),
    repo: figure(row, 'repo'),
    harness: figure(row, 'harness'),
    host: figure(row, 'host'),
    cost: figure(row, 'sessionCost'),
  }));

// The `data-press` value of the costliest row titled `title` of `html`.
function rowPress(html: string, title: string) {
  const row = parts(parts(html, 'data-list', 'costliest')[0] ?? '', 'data-part', 'costly').find((found) => text(parts(found, 'class', 'title grow')[0]) === title);
  assert.ok(row, `no row of ${title}: ${html}`);
  return attr(row, 'data-press')!;
}

test('Ten of twelve sessions', async () => {
  const { html, home } = await spendOf('week', (home) => {
    for (let i = 1; i <= 12; i++) ompSession(home, join(home, `repo${i}`), { title: `s${i}`, calls: [spent(13 - i, NOW - 3_600_000)] });
    ompSession(home, join(home, 'repo-old'), { title: 'old', calls: [spent(50, NOW - 21 * DAY)] });
  });

  assert.deepEqual(
    costliestOf(html()),
    Array.from({ length: 10 }, (_, i) => ({ title: `s${i + 1}`, repo: join(home, `repo${i + 1}`), harness: 'omp', host: 'local', cost: `$${(12 - i).toFixed(2)}` })),
  );
});

test('Shown session opens with the switch', async () => {
  const { html, live } = await (async () => {
    let home = '';
    const opened = await openLive([FIX], {
      prepare: (made) => {
        home = made;
        ompSession(made, folderOf(made, FIX), { title: 'Fix the login bug', calls: [spent(2)] });
      },
    });
    await until(() => opened.html().includes('data-part="counts"'));
    await caughtUp(home);
    await opened.openTab('spend', 'week');
    return opened;
  })();

  live.press(rowPress(html(), 'Fix the login bug'));
  await until(() => attr(html(), 'data-screen') === 'session' && parts(html(), 'data-part', 'loading').length === 0);

  assert.equal(attr(parts(html(), 'data-press', 'view:figures')[0], 'aria-pressed'), 'true');
  assert.equal(attr(parts(html(), 'data-press', 'view:trace')[0], 'aria-pressed'), 'false');
});

// The omp session `Port the parser`, on the tests' day, whose two sub-agents cost 0.5
// and 0.25, and the sessions of `home` around it.
function portTheParser(home: string) {
  const folder = join(home, 'parser');
  const at = (hms: string) => Date.parse(`2026-11-25T${hms}.000Z`);
  const main = ompSession(home, folder, { title: 'Port the parser', calls: [{ at: at('12:00:00'), output: 10, cost: 1 }] });
  ompSubAgent(home, folder, 'Impl1', { calls: [{ at: at('12:08:00'), output: 20, cost: 0.5 }], init: { at: at('12:01:00'), kind: 'task' }, parent: main });
  ompSubAgent(home, folder, 'Impl2', { calls: [{ at: at('12:09:00'), output: 30, cost: 0.25 }], init: { at: at('12:02:00'), kind: 'task' }, parent: main });
  return main;
}

test('Past session from the Spend tab', async () => {
  const { html, live, home } = await spendOf('month', portTheParser);

  live.press(rowPress(html(), 'Port the parser'));
  await until(() => attr(html(), 'data-screen') === 'past' && parts(html(), 'data-part', 'loading').length === 0);

  const screen = html();
  assert.equal(text(parts(screen, 'class', 'title grow')[0]), 'Port the parser');
  assert.deepEqual(
    ['repo', 'harness', 'models', 'cost', 'tokens', 'subAgents'].map((name) => figure(screen, name)),
    [join(home, 'parser'), 'omp', `anthropic/${MODEL}`, '$1.75', '60', '2 sub-agents'],
  );
  assert.equal(figure(screen, 'duration'), '2m 00s');
  assert.equal(parts(screen, 'data-lane').length, 4);
  assert.equal(parts(screen, 'data-part', 'switch').length, 0);

  live.press('back');
  await until(() => attr(html(), 'data-screen') === 'range' && parts(html(), 'data-part', 'loading').length === 0);
  assert.equal(attr(html(), 'data-tab'), 'spend');
  assert.equal(attr(parts(html(), 'data-press', 'range:month')[0], 'aria-pressed'), 'true');
});

test('Session whose files the harness deleted', async () => {
  let file = '';
  const { html, live, home } = await spendOf('month', (home) => {
    file = ompSession(home, join(home, 'api'), { title: 'Old job', calls: [{ at: Date.parse('2026-11-20T12:00:00.000Z'), output: 10, cost: 3 }] });
  });
  assert.ok(file);
  rmSync(file, { force: true });
  // the next ask runs a second catch-up, which finds the files gone
  mock.timers.tick(RANGE_REFRESH_MS);
  live.press('range:week');
  live.press('range:month');
  await caughtUp(home, 2);
  await until(() => attr(html(), 'data-screen') === 'range' && parts(html(), 'data-part', 'loading').length === 0);

  const chart = parts(html(), 'data-chart', 'range-cost')[0];
  assert.equal(attr(parts(chart, 'data-key', '2026-11-20')[0], 'data-v'), '3');
  live.press(rowPress(html(), 'Old job'));
  await until(() => attr(html(), 'data-screen') === 'past' && parts(html(), 'data-part', 'loading').length === 0);

  assert.equal(figure(html(), 'cost'), '$3.00');
  assert.equal(parts(html(), 'data-lane').length, 4);
});

test('Costliest sessions with no cost last, ties by id', async () => {
  const { html } = await spendOf('week', (home) => {
    const call = (cost?: number) => ({ at: NOW - 3_600_000, output: 10, ...(cost === undefined ? {} : { cost }) });
    ompSession(home, join(home, 'a'), { title: 'no cost', calls: [call()] });
    ompSession(home, join(home, 'b'), { title: 'small', calls: [call(0.5)] });
    ompSession(home, join(home, 'c'), { title: 'big', calls: [call(2)] });
  });

  assert.deepEqual(
    costliestOf(html()).map(({ title, cost }) => [title, cost]),
    [
      ['big', '$2.00'],
      ['small', '$0.50'],
      ['no cost', 'n/a'],
    ],
  );
});

// This computer's Orca host and `devbox`, a workspace of the omp session `Deploy it` on it, which
// the files under `remote` hold; `held`: what the stand-ins hold back.
const INFRA: HostWorkspace = { project: 'infra', name: 'main', agents: ['working'], hostId: `ssh:${DEVBOX}`, sessionId: 's1' };
const deployIt = (remote: string) => (home: string) => ompSession(remote, workspace(home, 'infra-main'), { title: 'Deploy it', calls: [spent(1)] });

test('Session on another Orca host', async () => {
  const remote = tempHome();
  let home = '';
  const opened = await openLive([INFRA], {
    homes: { devbox: remote },
    orca: DEVBOX_LISTS,
    prepare: (made) => {
      home = made;
      deployIt(remote)(made);
    },
  });
  await until(() => opened.html().includes('data-part="counts"'));
  await caughtUp(home);
  await opened.openTab('spend', 'week');

  // named as its card names its host, and opening the card's screen
  assert.deepEqual(costliestOf(opened.html()).map(({ title, host }) => [title, host]), [['Deploy it', 'devbox']]);
  assert.match(rowPress(opened.html(), 'Deploy it'), /^open:/);
});

test('The fleet does not wait on the probe of a remote host', async () => {
  const remote = tempHome();
  // the probe of the host asks for its machine id, which a card's read does not
  const machineId = process.platform === 'darwin' ? 'ioreg' : '/etc/machine-id';
  const held = `ssh devbox ${machineId}`;
  const opened = await openLive([INFRA], { homes: { devbox: remote }, orca: DEVBOX_LISTS, held: [held], prepare: deployIt(remote) });
  try {
    await until(() => opened.html().includes('data-part="counts"'));
    // only the catch-up's probe asked for the machine id: a probe for the card's session, which
    // the fleet then waited on until the held call timed out, would be a second. The catch-up
    // issues its probe on its own schedule, so count it only once it has been seen.
    const probes = () => opened.calls.ssh().filter((args) => args.at(-1)!.includes(machineId)).length;
    await until(() => probes() > 0);
    assert.equal(probes(), 1);
  } finally {
    opened.calls.release(held);
  }
});
