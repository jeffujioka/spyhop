// The Trace on the session screen (src/live/trace.ts): the Figures and Trace switch under the
// header, the four Trace lanes on one time axis with their total times, and the rows of the
// session's sub-agents, nested under the agent that started each, drawn by the live panel
// (`openOnFleet`, test/helpers/live.ts) from the real worker's session answer, whose Trace the
// history store keeps (src/history/store.ts) of the session files the catch-up brings up to date
// on each ask. The session files are written under a temporary home; the times are the tests' day.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { REFRESH_INTERVAL_MS } from '../../src/core/refresh.js';
import { opencodeSession, workspace } from '../helpers/agent-cards.ts';
import { tempHome } from '../helpers/files.ts';
import { claudeSession, claudeSubAgent, FIX, folderOf, type OmpCall, ompCalls, ompSession, ompSubAgent, openOnFleet, until } from '../helpers/live.ts';
import { attr, figure, parts, text } from '../helpers/markup.ts';
import { DEVBOX, DEVBOX_LISTS } from '../helpers/orca-answers.ts';
import type { HostWorkspace } from '../helpers/orca-host.ts';

// A time of the tests' day, `hh:mm:ss`, as epoch ms.
const t = (hms: string) => Date.parse(`2026-11-25T${hms}.000Z`);

// The live panel on `workspaces`, whose files `prepare` writes, with the session screen of its
// first card open; `homes` and `orca` go to the stand-ins, to reach another Orca host.
type Hosts = { homes?: Record<string, string>; orca?: Record<string, string> };
async function sessionScreenOf(workspaces: HostWorkspace[], prepare: (home: string) => void, hosts: Hosts = {}) {
  const opened = await openOnFleet(workspaces, { prepare, ...hosts });
  opened.live.press(attr(parts(opened.html(), 'data-part', 'card')[0], 'data-press')!);
  await until(() => parts(opened.html(), 'data-part', 'loading').length === 0);
  return opened;
}

// Whether `html` draws a Trace: its lanes, read from an answer.
const traced = (html: string) => parts(html, 'data-lane').length === 4;

// The live panel showing the Trace of the session of its first card.
async function traceOf(workspaces: HostWorkspace[], prepare: (home: string) => void, hosts: Hosts = {}) {
  const opened = await sessionScreenOf(workspaces, prepare, hosts);
  opened.live.press('view:trace');
  await until(() => traced(opened.html()));
  return opened;
}

// The lane `lane` of the Trace `html`: its spans, as [start, end], and its total time as written.
function laneOf(html: string, lane: string) {
  const [drawn] = parts(html, 'data-lane', lane);
  const spans = parts(drawn, 'data-span').map((span) => [Number(attr(span, 'data-start')), Number(attr(span, 'data-end'))]);
  return { spans, total: figure(drawn, 'laneTime') };
}

// The sub-agent rows of the Trace `html`: the text of each and its depth under the main agent.
const rowsOf = (html: string) => parts(html, 'data-agent').map((row) => ({ text: text(parts(row, 'class', 'row label')[0]), depth: Number(attr(row, 'data-depth')) }));

// The omp session of the folder of FIX under `home`, titled `Fix the login bug`, of `calls`.
const fixSession = (home: string, calls: OmpCall[]) => ompSession(home, folderOf(home, FIX), { title: 'Fix the login bug', calls });

// The spec's omp session with no sub-agent, its turns ending at 10:00:30 and 10:05:40.
const FIX_CALLS: OmpCall[] = [
  { prompted: t('10:00:00'), started: t('10:00:00'), at: t('10:00:05'), output: 10, stop: 'toolUse', tools: [{ name: 'read', started: t('10:00:05'), answered: t('10:00:20') }] },
  { started: t('10:00:20'), at: t('10:00:30'), output: 10, stop: 'stop' },
  { prompted: t('10:05:30'), started: t('10:05:30'), at: t('10:05:40'), output: 10, stop: 'stop' },
];

test('Switch to the Trace', async () => {
  const opened = await sessionScreenOf([FIX], (home) => ompCalls(home, folderOf(home, FIX), { title: 'Fix the login bug', contexts: [1000, 2000] }));
  const pressed = (html: string) => parts(parts(html, 'data-part', 'switch')[0], 'aria-pressed', 'true').map(text);
  assert.deepEqual(pressed(opened.html()), ['Figures']);
  assert.equal(parts(opened.html(), 'class', 'figures').length, 1);

  opened.live.press('view:trace');
  await until(() => traced(opened.html()));

  assert.deepEqual(pressed(opened.html()), ['Trace']);
  assert.deepEqual(
    parts(opened.html(), 'data-lane').map((lane) => attr(lane, 'data-lane')),
    ['thinking', 'tools', 'subagents', 'developer'],
  );
  assert.equal(parts(opened.html(), 'class', 'figures').length, 0);

  opened.live.press('view:figures');

  assert.deepEqual(pressed(opened.html()), ['Figures']);
  assert.equal(parts(opened.html(), 'class', 'figures').length, 1);
  assert.equal(parts(opened.html(), 'data-chart', 'context').length, 1);
  assert.equal(parts(opened.html(), 'data-lane').length, 0);
});

test('Trace refreshes', async () => {
  let file = '';
  let home = '';
  const opened = await traceOf([FIX], (at) => {
    home = at;
    file = fixSession(at, FIX_CALLS.slice(0, 2));
  });
  assert.equal(laneOf(opened.html(), 'thinking').spans.length, 2);

  // the same file, grown by a model call from 10:01:00 to 10:01:10
  assert.equal(fixSession(home, [...FIX_CALLS.slice(0, 2), { started: t('10:01:00'), at: t('10:01:10'), output: 10, stop: 'stop' }]), file);
  const asked = opened.requests('spyhop.session');
  mock.timers.tick(REFRESH_INTERVAL_MS);
  await until(() => opened.settled('spyhop.session') > asked);
  await until(() => laneOf(opened.html(), 'thinking').spans.length === 3);

  assert.deepEqual(laneOf(opened.html(), 'thinking').spans.at(-1), [t('10:01:00'), t('10:01:10')]);
});

test('Trace lanes of an omp session', async () => {
  const { html } = await traceOf([FIX], (home) => fixSession(home, FIX_CALLS));

  assert.deepEqual(laneOf(html(), 'thinking'), {
    spans: [
      [t('10:00:00'), t('10:00:05')],
      [t('10:00:20'), t('10:00:30')],
      [t('10:05:30'), t('10:05:40')],
    ],
    total: '25s',
  });
  assert.deepEqual(laneOf(html(), 'tools'), { spans: [[t('10:00:05'), t('10:00:20')]], total: '15s' });
  assert.deepEqual(laneOf(html(), 'developer'), { spans: [[t('10:00:30'), t('10:05:30')]], total: '5m 0s' });
  assert.deepEqual(laneOf(html(), 'subagents').spans, []);
  // each lane and the sub-agents' rows say what they are and what they mean
  for (const part of [...parts(html(), 'data-lane'), ...parts(html(), 'data-part', 'trace-agents')]) {
    assert.ok(text(parts(part, 'data-title')[0] ?? '').length > 0, part);
    assert.ok(text(parts(part, 'data-meaning')[0] ?? '').length > 0, part);
  }
});

test('Waiting on a sub-agent', async () => {
  const { html } = await traceOf([FIX], (home) => {
    // the `task` tool call from 10:00:00 to 10:10:05 starts `Impl1`; one model call meanwhile
    fixSession(home, [
      { prompted: t('09:59:58'), started: t('09:59:58'), at: t('10:00:00'), output: 10, stop: 'toolUse', tools: [{ name: 'task', started: t('10:00:00'), answered: t('10:10:05') }] },
      { started: t('10:04:00'), at: t('10:04:10'), output: 10, stop: 'stop' },
    ]);
    ompSubAgent(home, folderOf(home, FIX), 'Impl1', { calls: [{ at: t('10:10:00'), output: 10, cost: 0.5 }], init: { at: t('10:00:01'), kind: 'task' } });
  });

  assert.deepEqual(laneOf(html(), 'subagents'), {
    spans: [
      [t('10:00:01'), t('10:04:00')],
      [t('10:04:10'), t('10:10:00')],
    ],
    total: '9m 49s',
  });
});

test('Model calls of Claude Code', async () => {
  const web: HostWorkspace = { project: 'web', name: 'main', agents: ['working'], harness: 'claude' };
  const { html } = await traceOf([web], (home) =>
    claudeSession(home, workspace(home, 'web-main'), {
      calls: [
        { prompted: t('10:00:00'), blocks: [t('10:00:04')], at: t('10:00:06'), output: 10, stop: 'tool_use', tools: [{ name: 'Bash', answered: t('10:00:09') }] },
        { at: t('10:00:15'), output: 10, stop: 'end_turn' },
      ],
    }),
  );

  assert.deepEqual(laneOf(html(), 'thinking').spans, [
    [t('10:00:00'), t('10:00:06')],
    [t('10:00:09'), t('10:00:15')],
  ]);
  assert.deepEqual(laneOf(html(), 'tools').spans, [[t('10:00:06'), t('10:00:09')]]);
});

test('Nested omp sub-agents', async () => {
  const { html } = await traceOf([FIX], (home) => {
    const folder = folderOf(home, FIX);
    const main = ompSession(home, folder, {
      title: 'Fix the login bug',
      calls: [{ at: t('10:00:00'), output: 10, cost: 1 }],
      results: [{ at: t('10:09:00'), jobs: [{ jobId: 'Impl1', status: 'completed' }] }],
    });
    const impl = ompSubAgent(home, folder, 'Impl1', {
      calls: [{ at: t('10:08:00'), output: 10, cost: 0.5 }],
      init: { at: t('10:01:00'), kind: 'task' },
      parent: main,
      results: [{ at: t('10:07:00'), jobs: [{ jobId: 'Rev1', status: 'failed' }] }],
    });
    ompSubAgent(home, folder, 'Impl1/Rev1', { calls: [{ at: t('10:06:00'), output: 10, cost: 0.25 }], init: { at: t('10:02:00'), kind: 'reviewer' }, parent: impl });
  });

  assert.deepEqual(rowsOf(html()), [
    { text: 'Impl1 · completed · $0.50', depth: 1 },
    { text: 'Rev1 · failed · $0.25', depth: 2 },
  ]);
});

test('Claude Code sub-agent', async () => {
  const web: HostWorkspace = { project: 'web', name: 'main', agents: ['working'], harness: 'claude' };
  const { html } = await traceOf([web], (home) => {
    const folder = workspace(home, 'web-main');
    // the first call's first tool use is `toolu_0_0`
    claudeSession(home, folder, { calls: [{ at: t('10:00:00'), output: 10, tools: [{ name: 'Task', answered: t('10:05:00'), status: 'completed' }] }] });
    claudeSubAgent(home, folder, 'a1', { calls: [{ at: t('10:04:00'), output: 10 }], model: 'claude-haiku-4-5', meta: { agentType: 'general', description: 'Find the docs', toolUseId: 'toolu_0_0' } });
  });

  assert.deepEqual(rowsOf(html()), [{ text: 'Find the docs · completed · n/a', depth: 1 }]);
});

test('opencode sub-agents', async () => {
  const web: HostWorkspace = { project: 'web', name: 'main', agents: ['working'], harness: 'opencode', sessionId: 'ses_p' };
  const { html } = await traceOf([web], (home) => {
    const base = { provider: 'anthropic', model: 'm', cost: 0.1 };
    const call = (child: string, status: string) => ({ uncached: 1, read: 0, write: 0, output: 1, tools: [{ name: 'subagent', status, child }] });
    opencodeSession(home, workspace(home, 'web-main'), { ...base, id: 'ses_p', title: 'Ship it', calls: [call('ses_c', 'completed')] });
    const children = join(home, 'children');
    opencodeSession(home, children, { ...base, id: 'ses_c', title: 'Explore the repo', parent: 'ses_p', calls: [call('ses_g', 'error')], update: true });
    opencodeSession(home, children, { ...base, id: 'ses_g', title: 'Read the tests', parent: 'ses_c', calls: [{ uncached: 1, read: 0, write: 0, output: 1 }], update: true });
  });

  assert.deepEqual(rowsOf(html()), [
    { text: 'Explore the repo · completed · $0.10', depth: 1 },
    { text: 'Read the tests · error · $0.10', depth: 2 },
  ]);
});

test('Trace of a session on another Orca host', async () => {
  const remote = tempHome();
  const infra: HostWorkspace = { project: 'infra', name: 'main', agents: ['working'], hostId: `ssh:${DEVBOX}`, sessionId: 's1' };
  const { html } = await traceOf([infra], (home) => ompSession(remote, workspace(home, 'infra-main'), { title: 'Deploy it', calls: FIX_CALLS }), {
    homes: { devbox: remote },
    orca: DEVBOX_LISTS,
  });

  assert.equal(laneOf(html(), 'thinking').total, '25s');
});
