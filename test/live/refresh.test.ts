// The open live panel asks the worker for the fleet again every REFRESH_INTERVAL_MS and redraws
// it; a closed panel, hidden or closed, asks nothing. Each request starts REFRESH_INTERVAL_MS
// after the previous one started, or at its answer when that came later. During a request the
// panel draws each Orca host's group as the worker posts it, and the answer then replaces them
// all. The controller (src/live/controller.ts) runs over the real worker, through the frame the
// tests play (`openLive`, test/helpers/live.ts); the worker reads the harnesses' files with the
// real programs under a temporary home, and the `orca` CLI and `ssh`, stood in for
// (test/helpers/stand-ins.ts), list and reach the SSH host `devbox` when a test names it. Time is
// node:test's mock clock; an answer comes late by holding back Orca's `workspace.list`, or every
// command on `devbox`.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { REFRESH_INTERVAL_MS } from '../../src/core/refresh.js';
import { tabBar } from '../../src/live/tabs.ts';
import type { GroupPost } from '../../src/protocol.ts';
import { costTurn, ompSessionOf } from '../helpers/agent-cards.ts';
import { tempHome } from '../helpers/files.ts';
import { caughtUp } from '../helpers/history.ts';
import { openLive, until } from '../helpers/live.ts';
import { figure, parts, text } from '../helpers/markup.ts';
import { DEVBOX, DEVBOX_LISTS } from '../helpers/orca-answers.ts';
import type { HostWorkspace } from '../helpers/orca-host.ts';

// This computer's workspace `api`/`main`, with one working omp agent on the session `s1`, which
// has logged 0.10 USD when a test writes it (`session`).
const MAIN: HostWorkspace = { project: 'api', name: 'main', agents: ['working'], sessionId: 's1' };
// The SSH workspace `infra`/`deploy` on `devbox`, with one omp agent in `agents`' state.
const deploy = (state: HostWorkspace['agents'][number]): HostWorkspace => ({ project: 'infra', name: 'deploy', agents: [state], hostId: `ssh:${DEVBOX}` });

let file = '';
// Writes the session of MAIN under `home`.
const session = (home: string) => {
  file = ompSessionOf(home, join(home, 'work/api-main'));
};
// The groups the fleet screen `html` draws, by host name.
const hosts = (html: string) => [...html.matchAll(/<section data-part="group" data-host="([^"]*)"/g)].map(([, name]) => name);
const costOf = (html: string) => figure(html, 'cost');

// The panel opened on MAIN, once it has drawn its first answer.
async function openOnSession() {
  const opened = await openLive([MAIN], { prepare: session });
  await until(() => costOf(opened.html()) === '$0.10');
  return opened;
}

// The panel opened on MAIN, then closed and opened again with the answer to that request held
// back. `lists()`: how many times `workspace.list` has been called since it opened again.
async function openWithAnswerHeld() {
  const opened = await openOnSession();
  const { live, host } = opened;
  live.show(false);
  const before = host.callsOf('workspace.list').length;
  const lists = () => host.callsOf('workspace.list').length - before;
  const release = host.holdLists();
  live.show(true);
  await until(() => lists() === 1);
  return { ...opened, lists, release };
}

test('Open panel refreshes', async () => {
  const { html } = await openOnSession();

  appendFileSync(file, costTurn(0.15));
  mock.timers.tick(REFRESH_INTERVAL_MS);

  await until(() => costOf(html()) === '$0.25');
});

test('a failed refresh keeps the screen and the next one redraws', async () => {
  const { html, host } = await openOnSession();
  appendFileSync(file, costTurn(0.15));

  const end = host.failLists();
  mock.timers.tick(REFRESH_INTERVAL_MS);
  await until(() => host.callsOf('workspace.list').length === 2);
  assert.equal(costOf(html()), '$0.10');

  end();
  mock.timers.tick(REFRESH_INTERVAL_MS);
  await until(() => costOf(html()) === '$0.25');
});

test('Closed panel reads nothing', async () => {
  const { live, host, calls, requests, html } = await openOnSession();
  // the worker's first catch-up, at its start, has ended: the next is 15 minutes away
  await caughtUp(process.env.HOME!);
  // Lets 2 seconds pass twice, and checks that they started no request, listed no agent, read
  // no session and ran no command.
  function nothingRead() {
    const before = [requests('spyhop.fleet'), host.calls.length, calls.orca().length, calls.ssh().length];
    mock.timers.tick(REFRESH_INTERVAL_MS);
    mock.timers.tick(REFRESH_INTERVAL_MS);
    assert.deepEqual([requests('spyhop.fleet'), host.calls.length, calls.orca().length, calls.ssh().length], before);
  }
  // open, it asks again every 2 seconds
  appendFileSync(file, costTurn(0.15));
  mock.timers.tick(REFRESH_INTERVAL_MS);
  await until(() => costOf(html()) === '$0.25');

  // hidden, it asks nothing
  live.show(false);
  nothingRead();

  // shown again, it asks at once; closed, never again
  appendFileSync(file, costTurn(0.05));
  live.show(true);
  assert.equal(requests('spyhop.fleet'), 3);
  await until(() => costOf(html()) === '$0.30');
  live.close();
  nothingRead();
  live.show(true);
  assert.equal(requests('spyhop.fleet'), 3);
});

test('Next request starts 2 seconds after the previous one started', async () => {
  const { html, lists, release, requests } = await openWithAnswerHeld();

  // the answer, with the new cost, arrives 1.5 seconds after the request started
  appendFileSync(file, costTurn(0.15));
  mock.timers.tick(1500);
  release();
  await until(() => costOf(html()) === '$0.25');
  mock.timers.tick(REFRESH_INTERVAL_MS - 1500 - 1);
  assert.equal(lists(), 1);

  mock.timers.tick(1);
  assert.equal(requests('spyhop.fleet'), 3);
  await until(() => lists() === 2);
});

test('Answer slower than 2 seconds', async () => {
  const { lists, release, requests } = await openWithAnswerHeld();

  mock.timers.tick(3000);
  assert.equal(requests('spyhop.fleet'), 2);
  assert.equal(lists(), 1);

  // the answer arrives: the second request starts with no more time passing
  release();
  await until(() => lists() === 2);
  assert.equal(requests('spyhop.fleet'), 3);
});

test("This computer's rows before a slow remote host answers", async () => {
  const { html, calls } = await openLive([MAIN, deploy('blocked')], {
    homes: { devbox: tempHome() },
    orca: DEVBOX_LISTS,
    held: ['ssh devbox'],
    prepare: session,
  });
  // `devbox` was asked, and its answers are held back
  await calls.until(() => calls.ssh().some(([alias]) => alias === 'devbox'));
  try {
    await until(() => hosts(html()).length > 0);
    assert.deepEqual(hosts(html()), ['local']);
    assert.equal(costOf(html()), '$0.10');
    assert.deepEqual(parts(html(), 'data-part', 'counts'), []);
  } finally {
    calls.release('ssh devbox');
  }

  await until(() => hosts(html()).length === 2);
  assert.deepEqual(hosts(html()), ['local', 'devbox']);
  assert.equal(parts(parts(html(), 'data-host', 'devbox')[0], 'data-part', 'card').length, 1);
  assert.deepEqual([figure(html(), 'blocked'), figure(html(), 'working')], ['1', '1']);
});

test('Host rows of an older request are ignored', async () => {
  const { html, worker, frame, host } = await openOnSession();
  appendFileSync(file, costTurn(0.15));
  mock.timers.tick(REFRESH_INTERVAL_MS);
  await until(() => costOf(html()) === '$0.25');
  // the group of `local` built for the first request
  const older = worker.posts[0].payload as GroupPost;
  assert.deepEqual([worker.posts.length, older.request, older.group.id, older.group.cards[0].cost], [2, 1, 'local', 0.1]);

  frame.post('spyhop.group', older);
  assert.equal(costOf(html()), '$0.25');
  // nor is a group of the newest request, once its answer is drawn
  frame.post('spyhop.group', { ...older, request: 2 });
  assert.equal(costOf(html()), '$0.25');

  // nor, while a newer request is out, a group of an older one
  const release = host.holdLists();
  mock.timers.tick(REFRESH_INTERVAL_MS);
  await until(() => host.callsOf('workspace.list').length === 3);
  try {
    frame.post('spyhop.group', older);
    assert.equal(costOf(html()), '$0.25');
    // while a group of the request out takes the place of the drawn group of its host
    frame.post('spyhop.group', { ...older, request: 3 });
    assert.equal(costOf(html()), '$0.10');
    assert.deepEqual(hosts(html()), ['local']);
  } finally {
    release();
  }
  // which the answer replaces
  await until(() => costOf(html()) === '$0.25');
});

test('Host that is gone disappears with the answer', async () => {
  const { html, host } = await openLive([MAIN, deploy('working')], { homes: { devbox: tempHome() }, orca: DEVBOX_LISTS, prepare: session });
  await until(() => hosts(html()).length === 2);
  assert.deepEqual(hosts(html()), ['local', 'devbox']);

  host.remove('deploy');
  mock.timers.tick(REFRESH_INTERVAL_MS);

  await until(() => hosts(html()).length === 1);
  assert.deepEqual(hosts(html()), ['local']);
  assert.equal(parts(parts(html(), 'data-host', 'local')[0], 'data-part', 'card').length, 1);
});

test('Panel before the first answer', async () => {
  // openLive returns once the first request has started, before it can have been answered
  const { html } = await openLive([MAIN], { prepare: session });

  assert.deepEqual(parts(html(), 'data-part', 'loading').map(text), ['Reading the Orca agents']);
});

test('Fleet with no Orca agents', async () => {
  const { html } = await openLive([]);

  await until(() => parts(html(), 'data-part', 'loading').length === 0);
  assert.equal(text(html().replace(tabBar('live', null), '')), 'No Orca agents');
});

// A draw that throws reaches the page as an unhandled rejection, which Orca logs as a `[frame]`
// error; only a failed request is kept quiet. The test runner's own listeners would fail the test
// on that rejection, so they are set aside while it waits for it.
test('A failed draw is not kept quiet', async () => {
  const kept = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  try {
    let failed: Error | undefined;
    process.once('unhandledRejection', (reason) => {
      failed = reason as Error;
    });
    // only the whole answer's draw has the header's counts
    const { html } = await openLive([MAIN], {
      prepare: session,
      onDraw: (html) => {
        if (html.includes('data-part="counts"')) throw new Error('the draw failed');
      },
    });
    await until(() => html().includes('data-part="counts"'));

    // the rejection is handed to the listeners once the turn that left it unhandled is over
    await until(() => failed !== undefined);
    assert.equal(failed?.message, 'the draw failed');
  } finally {
    for (const listener of kept) process.on('unhandledRejection', listener);
  }
});
