// The session screen's Focus button: pressing it asks Orca to focus the pane of the session's Orca
// agent, by `terminal.focus` on this computer and on an SSH workspace and by `orca terminal switch`
// on a paired Orca server, and runs nothing over ssh; a session screen whose agent has no pane
// shows no button; a press that cannot focus changes nothing drawn, and the worker logs why. The
// controller (src/live/controller.ts) runs over the real worker, through the frame the tests play
// (`openLive`, test/helpers/live.ts); the `orca` CLI and `ssh`, stood in for
// (test/helpers/stand-ins.ts), list the SSH host `devbox` or play the paired server `jeff`, and
// log their calls. Time is node:test's mock clock, which no test moves: the calls after a press
// are the press's own.
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { test } from 'node:test';
import type { MockHost, TestWorker } from 'orca/testing';
import type { Live } from '../../src/live/controller.ts';
import { tempHome } from '../helpers/files.ts';
import { caughtUp } from '../helpers/history.ts';
import { open, openOnFleet, until } from '../helpers/live.ts';
import { parts } from '../helpers/markup.ts';
import { DEVBOX, DEVBOX_LISTS, JEFF_AGENT_LIST, JEFF_LISTS, JEFF_TERMINAL_LIST } from '../helpers/orca-answers.ts';
import type { HostWorkspace } from '../helpers/orca-host.ts';
import { serverAgent } from '../helpers/server-agent.ts';
import { answer } from '../helpers/stand-ins.ts';

const SWITCH = 'terminal switch --environment jeff --terminal term-9 --json';

// The server's omp Orca agents: the one of its workspace `main`, in the pane of `term-9`, and
// the one of its workspace `lost`, in a pane no listed terminal is in.
const MAIN = serverAgent('/home/jeff/work/spyhop-main', 'main', 'tab1:leaf2');
const LOST = serverAgent('/home/jeff/work/spyhop-lost', 'lost', 'tab7:leaf7');

// The server's terminal `term-9`, in the tab `tab1` and its leaf `leaf2`, titled as omp titles the
// pane of an untitled session: its mark and the folder's name, which the card's title drops.
const TERMINALS = {
  terminals: [
    { handle: 'term-9', ptyId: 'pty-9', orphaned: false, worktreeId: 'repo-spyhop::/home/jeff/work/spyhop-main', tabId: 'tab1', leafId: 'leaf2', title: 'π - spyhop-main', connected: true },
  ],
  totalCount: 1,
  truncated: false,
};

// What `orca terminal switch --environment jeff` answers: `navigated` false when no desktop here
// shows the server.
const switched = (navigated: boolean) => answer({ focus: { handle: 'term-9', tabId: 'tab1', navigated } });

// What the tests use of the panel `openLive` opens.
type Shown = { live: Live; html: () => string };

// The panel opened on this computer's Orca workspaces `workspaces` and the paired server `jeff`,
// which lists the agents `agents` and the terminals TERMINALS; `orca` adds commands the CLI answers.
const openOnJeff = (agents: object[], workspaces: HostWorkspace[] = [], orca: Record<string, string> = {}) =>
  openOnFleet(workspaces, {
    homes: { jeff: tempHome() },
    orca: { ...JEFF_LISTS, [JEFF_AGENT_LIST]: answer({ agents }), [JEFF_TERMINAL_LIST]: answer(TERMINALS), ...orca },
  });

// Whether the session screen `html` shows the Focus button.
const hasFocus = (html: string) => parts(html, 'data-press', 'focus').length === 1;

// Presses the Focus button of the session screen drawn, and waits until the panel has taken the
// worker's answer, or its failure; returns the terminals Orca was asked to focus, the ssh and orca
// CLI calls the press made, and the screens drawn before and after it.
async function pressFocus({
  live,
  html,
  host,
  calls,
  settled,
}: Shown & { host: MockHost; calls: { ssh(): string[][]; orca(): string[] }; settled: (name: string) => number }) {
  assert.ok(hasFocus(html()), html());
  // the worker's first catch-up, which reads every listed host, has ended: the calls after the
  // press are the press's own
  await caughtUp(homedir());
  const [ssh, orca, focused, before] = [calls.ssh().length, calls.orca().length, host.callsOf('terminal.focus').length, html()];

  live.press('focus');

  await until(() => settled('spyhop.focus') === 1);
  return { focused: host.callsOf('terminal.focus').slice(focused), ssh: calls.ssh().slice(ssh), orca: calls.orca().slice(orca), before, after: html() };
}

// The worker's log lines that name `name`.
const logged = ({ worker }: { worker: TestWorker }, name: string) => worker.logs.filter((line) => line.includes(name));

test('Focus pane on this computer', async () => {
  const opened = await openOnFleet([{ project: 'api', name: 'main', agents: ['working'], terminals: ['local-t1'] }], { homes: { devbox: tempHome() }, orca: DEVBOX_LISTS });
  await open(opened, 'api-main');

  const pressed = await pressFocus(opened);

  assert.deepEqual(pressed.focused, [{ terminalId: 'local-t1' }]);
  assert.deepEqual(pressed.ssh, []);
  assert.deepEqual(pressed.orca, []);
  assert.deepEqual(opened.worker.refusals, []);
});

test('Focus pane on an SSH workspace', async () => {
  const opened = await openOnFleet(
    [{ project: 'infra', name: 'deploy', agents: ['working'], terminals: ['devbox-t2'], hostId: `ssh:${DEVBOX}` }],
    { homes: { devbox: tempHome() }, orca: DEVBOX_LISTS },
  );
  await open(opened, 'infra-deploy');

  const pressed = await pressFocus(opened);

  assert.deepEqual(pressed.focused, [{ terminalId: 'devbox-t2' }]);
  assert.deepEqual(pressed.ssh, []);
  assert.deepEqual(pressed.orca, []);
  assert.deepEqual(opened.worker.refusals, []);
});

test('Focus pane on a paired Orca server', async () => {
  const opened = await openOnJeff([MAIN], [], { [SWITCH]: switched(true) });
  await open(opened, 'spyhop-main');

  const pressed = await pressFocus(opened);

  assert.deepEqual(pressed.orca, [SWITCH]);
  assert.deepEqual(pressed.ssh, []);
  assert.deepEqual(pressed.focused, []);
  assert.deepEqual(opened.worker.refusals, []);
  assert.deepEqual(opened.worker.logs, []);
});

test('Session screen without a pane', async () => {
  // a local agent in a chat, an agent of the server whose pane no listed terminal is in, and,
  // to show a matched pane still draws its button, one whose pane is `term-9`'s
  const opened = await openOnJeff([LOST, MAIN], [{ project: 'api', name: 'chat', agents: ['working'], terminals: [null] }]);
  const screens: Record<string, boolean> = {};
  for (const title of ['api-chat', 'spyhop-lost', 'spyhop-main']) {
    // back to the fleet before the next card; the fleet ask it starts is answered before the
    // session's, so no ask is left out when the test ends
    if (title !== 'api-chat') opened.live.press('back');
    await open(opened, title);
    screens[title] = hasFocus(opened.html());
  }

  assert.deepEqual(screens, { 'api-chat': false, 'spyhop-lost': false, 'spyhop-main': true });
});

test('Paired server cannot switch', async () => {
  // the stand-in answers no `terminal switch`: it fails as the CLI does
  const opened = await openOnJeff([MAIN]);
  await open(opened, 'spyhop-main');

  const pressed = await pressFocus(opened);

  assert.equal(pressed.after, pressed.before);
  assert.deepEqual(pressed.orca, [SWITCH]);
  assert.deepEqual(pressed.ssh, []);
  const lines = logged(opened, 'term-9');
  assert.equal(lines.length, 1, JSON.stringify(opened.worker.logs));
  assert.match(lines[0], /not_found/);
});

test('Paired server no desktop here shows', async () => {
  const opened = await openOnJeff([MAIN], [], { [SWITCH]: switched(false) });
  await open(opened, 'spyhop-main');

  const pressed = await pressFocus(opened);

  assert.equal(pressed.after, pressed.before);
  assert.deepEqual(pressed.orca, [SWITCH]);
  assert.deepEqual(await opened.worker.request('spyhop.focus', { environment: 'jeff', terminal: 'term-9' }), { focused: false });
  const lines = logged(opened, 'term-9');
  assert.equal(lines.length, 2, JSON.stringify(opened.worker.logs));
  assert.match(lines[0], /did not navigate/);
});

test('Paired server switch that answers no focus', async () => {
  const opened = await openOnJeff([MAIN], [], { [SWITCH]: answer({}) });
  await open(opened, 'spyhop-main');

  const pressed = await pressFocus(opened);

  assert.equal(pressed.after, pressed.before);
  assert.deepEqual(await opened.worker.request('spyhop.focus', { environment: 'jeff', terminal: 'term-9' }), { focused: false });
  assert.equal(logged(opened, 'term-9').length, 2, JSON.stringify(opened.worker.logs));
});

test('Truncated terminal list of a paired server is logged', async () => {
  const opened = await openOnJeff([MAIN], [], { [JEFF_TERMINAL_LIST]: answer({ ...TERMINALS, totalCount: 201, truncated: true }) });

  // the listed terminals still give their panes
  await open(opened, 'spyhop-main');
  assert.ok(hasFocus(opened.html()));
  const lines = logged(opened, 'jeff');
  assert.ok(lines.length > 0, JSON.stringify(opened.worker.logs));
  assert.match(lines[0], /jeff listed 1 of 201 terminals: agents in the others have no pane to focus/);
});

test('Focus press the worker cannot answer changes nothing', async () => {
  const opened = await openOnJeff([MAIN], [], { [SWITCH]: switched(true) });
  await open(opened, 'spyhop-main');
  // the worker is gone: the panel's request rejects
  await opened.worker.deactivate();

  const pressed = await pressFocus(opened);

  assert.equal(pressed.after, pressed.before);
  assert.deepEqual(pressed.orca, []);
});
