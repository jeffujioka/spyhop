// The session screen (src/live/session.ts): the header, the four figures, the context, tokens and
// cost cards, and the Tools, Models and Session sections, drawn from the real worker's session
// answer over session files under a temporary home (`sessionOf`, test/helpers/live.ts), and read
// through the markup's conventions (test/helpers/markup.ts). The `orca` CLI and `ssh`, stood in
// for (test/helpers/stand-ins.ts), list and reach the SSH host `devbox` when a test names it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatDate, formatDay, formatSeconds } from '../../src/core/format.js';
import { fleetScreen } from '../../src/live/fleet.ts';
import { NOW, workspace } from '../helpers/agent-cards.ts';
import { setEnv } from '../helpers/env.ts';
import { tempHome } from '../helpers/files.ts';
import { claudeCalls, claudeSession, MODEL, ompCalls, ompSession, sessionOf, toolCalls } from '../helpers/live.ts';
import { figure, parts, text, textOutsideFigures } from '../helpers/markup.ts';
import { DEVBOX, DEVBOX_LISTS } from '../helpers/orca-answers.ts';
import type { HostWorkspace } from '../helpers/orca-host.ts';

// This computer's workspace `api`/`main` with one working omp agent titled `π - <title>`.
const ompAgent = (title: string): HostWorkspace[] => [{ project: 'api', name: 'main', agents: ['working'], title: `π - ${title}` }];

// Wednesday 25 November 2026, 15:33 (UTC, the tests' time zone).
const WED_15_33 = Date.parse('2026-11-25T15:33:00.000Z');
const MINUTE = 60_000;

// The rows of the section `part` of `html`, each as the text it shows.
const rows = (html: string, part: string) => parts(parts(html, 'data-part', part)[0], 'class', 'row item').map(text);

test('Header of an omp session', async () => {
  const { html } = await sessionOf([{ ...ompAgent('Fix the login bug')[0], sessionId: 's1', stateStartedAt: NOW - 3 * MINUTE }], {
    // a session named by its id, which records a folder outside the workspace's
    prepare: (home) => ompCalls(home, join(home, 'projects/boto'), { title: 'Fix the login bug', contexts: [] }),
  });

  assert.match(html, /^<main data-screen="session">/);
  const [header] = parts(html, 'data-part', 'header');
  assert.equal(parts(header, 'data-press', 'back').length, 1);
  assert.match(parts(header, 'data-press', 'back')[0], /^<button type="button"/);
  assert.match(header, /^<[^>]* data-state="working"/);
  assert.equal(parts(header, 'class', 'dot').length, 1);
  assert.match(header, /<b class="title[^"]*">Fix the login bug<\/b>/);
  assert.equal(text(parts(header, 'class', 'meta')[0]), `omp · ${MODEL} · ~/projects/boto · working · 3m`);
  // the time in its state is a figure, in the figures' font; the rest of the line is text
  assert.match(parts(header, 'data-figure', 'since')[0], /^<[^>]* class="num"/);
  assert.equal(textOutsideFigures(parts(header, 'class', 'meta')[0]), `omp · ${MODEL} · ~/projects/boto · working ·`);
});

test('Duration and start', async () => {
  const end = WED_15_33 + (22 * 60 + 31) * MINUTE;
  const { html } = await sessionOf(ompAgent('Run the night build'), {
    now: end + MINUTE,
    prepare: (home) =>
      ompSession(home, join(workspace(home, 'api-main'), 'night'), {
        title: 'Run the night build',
        calls: [
          { at: WED_15_33, output: 10, cost: 0.1 },
          { at: end, output: 10, cost: 0.1 },
        ],
      }),
  });

  assert.equal(figure(html, 'duration'), '22h 31m');
  assert.equal(figure(html, 'start'), 'Wed 15:33');
});

test('Cost card says where the cost comes from', async () => {
  const { html, fleet } = await sessionOf(ompAgent('Fix the login bug'), {
    prepare: (home) =>
      ompSession(home, join(workspace(home, 'api-main'), 'login'), {
        title: 'Fix the login bug',
        calls: [
          { at: NOW - 2 * MINUTE, read: 900, uncached: 100, cost: 0.25 },
          { at: NOW - MINUTE, read: 900, uncached: 100, cost: 0.75 },
        ],
      }),
  });

  const [costCard] = parts(html, 'class', 'cost-card');
  assert.equal(figure(costCard, 'total'), '$1.00');
  assert.match(text(costCard), /\$1\.00 as omp logged it/);
  assert.equal(parts(costCard, 'data-chart', 'cost').length, 1);
  const [figures] = parts(html, 'class', 'figures');
  assert.equal(figure(figures, 'cost'), '$1.00');
  // the tokens, 1,800 of 2,000 of them read from the prompt cache
  assert.equal(text(parts(figures, 'class', 'figure')[1]), 'Tokens 2k 90% from cache');
  assert.doesNotMatch(text(figures), /logged/);
  assert.equal(text(html).match(/logged/g)?.length, 1);
  const [card] = parts(fleetScreen({ groups: fleet.groups, whole: fleet }), 'data-part', 'card');
  assert.equal(figure(card, 'cost'), '$1.00');
  assert.doesNotMatch(text(card), /logged/);
});

test('Six tools named, the rest as others', async () => {
  const tools = [
    ...toolCalls('bash', 412, 5),
    ...toolCalls('read', 388),
    ...toolCalls('edit', 141, 3),
    ...toolCalls('grep', 96),
    ...toolCalls('task', 90, 1),
    ...toolCalls('write', 44),
    ...toolCalls('glob', 20),
    ...toolCalls('fetch', 15),
  ];
  const { html } = await sessionOf(ompAgent('Fix the login bug'), {
    prepare: (home) => ompSession(home, join(workspace(home, 'api-main'), 'login'), { title: 'Fix the login bug', calls: [{ at: NOW - MINUTE, output: 10, cost: 0.1, tools }] }),
  });

  const [section] = parts(html, 'data-part', 'tools');
  assert.equal(text(parts(section, 'class', 'row head')[0]), 'Tools 1,206 tool calls · 9 failed');
  assert.deepEqual(rows(html, 'tools'), ['bash 412 5 failed', 'read 388', 'edit 141 3 failed', 'grep 96', 'task 90 1 failed', 'write 44', 'others 35']);
  // the session's own failed tool calls, under its model calls
  assert.equal(figure(html, 'failedTools'), '9');
  // every count of the section is a figure, in the figures' font
  assert.equal(textOutsideFigures(section), 'Tools tool calls · failed bash failed read edit failed grep task failed write others');
});

test('Failed tool call of a Claude Code session', async () => {
  const { html } = await sessionOf([{ project: 'web', name: 'main', agents: ['working'], harness: 'claude' }], {
    prepare: (home) =>
      claudeSession(home, workspace(home, 'web-main'), {
        calls: [0, 1, 2].map((i) => ({ at: NOW - MINUTE + i, uncached: 1000, output: 10, tools: [{ name: 'Bash', failed: i === 1 }] })),
      }),
  });

  const [section] = parts(html, 'data-part', 'tools');
  assert.equal(text(parts(section, 'class', 'row head')[0]), 'Tools 3 tool calls · 1 failed');
  assert.deepEqual(rows(html, 'tools'), ['Bash 3 1 failed']);
  // Claude Code logs no cost per model call: its models by tokens
  assert.deepEqual(rows(html, 'models'), ['claude-opus-4-6 · main agent · 3,030 tokens']);
  // the model's name is text, in the text font, and its tokens a figure
  assert.equal(textOutsideFigures(parts(html, 'data-part', 'models')[0]), 'Models by tokens claude-opus-4-6 · main agent · tokens');
});

test('Session section of a local omp session', async () => {
  const { html } = await sessionOf(ompAgent('Fix the login bug'), {
    now: WED_15_33 + 10 * MINUTE,
    prepare: (home) => {
      const spyhop = join(workspace(home, 'api-main'), 'spyhop');
      mkdirSync(spyhop, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: spyhop });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/jeffujioka/spyhop.git'], { cwd: spyhop });
      ompSession(home, spyhop, {
        title: 'Fix the login bug',
        thinking: 'high',
        calls: [
          { at: WED_15_33, output: 10, cost: 0.1, premium: 300 },
          { at: WED_15_33 + 5 * MINUTE, prompted: WED_15_33 + 5 * MINUTE - 2900, output: 10, cost: 0.1, premium: 18 },
        ],
      });
    },
  });

  const [section] = parts(html, 'data-part', 'session');
  assert.deepEqual(
    ['started', 'thinking', 'latency', 'premium', 'branch', 'remote'].map((name) => figure(section, name)),
    ['Wed 25 Nov, 15:33', 'high', '2.9s', '318', 'main', 'github.com/jeffujioka/spyhop'],
  );
  // the words are set in the text font, only the figures in theirs
  assert.equal(textOutsideFigures(section), 'Session Started Thinking high Last reply Premium Branch main Remote github.com/jeffujioka/spyhop');
  assert.equal(figure(section, 'host'), undefined);
  assert.doesNotMatch(text(section), /Host/);
});

test('Session on another Orca host', async () => {
  const remote = tempHome();
  const { html } = await sessionOf([{ project: 'infra', name: 'main', agents: ['working'], hostId: `ssh:${DEVBOX}`, sessionId: 's1' }], {
    homes: { devbox: remote },
    orca: DEVBOX_LISTS,
    prepare: (home) => ompCalls(remote, workspace(home, 'infra-main'), { title: 'Deploy it', contexts: [] }),
  });

  assert.equal(figure(parts(html, 'data-part', 'session')[0], 'host'), 'devbox');
});

test('Folder without git and figure not recorded', async () => {
  const { html } = await sessionOf([{ project: 'web', name: 'main', agents: ['working'], harness: 'claude' }], {
    prepare: (home) => claudeCalls(home, workspace(home, 'web-main'), [1000]),
  });

  const [section] = parts(html, 'data-part', 'session');
  assert.equal(figure(section, 'premium'), 'n/a');
  assert.equal(figure(section, 'branch'), undefined);
  assert.equal(figure(section, 'remote'), undefined);
  assert.doesNotMatch(text(section), /Branch|Remote/);
});

test('Session screen without sub-agents and tool calls', async () => {
  const { html } = await sessionOf(ompAgent('Fix the login bug'), {
    prepare: (home) => ompCalls(home, join(workspace(home, 'api-main'), 'login'), { title: 'Fix the login bug', contexts: [1000, 2000] }),
  });

  assert.deepEqual(parts(html, 'data-part', 'subagents'), []);
  assert.deepEqual(parts(html, 'data-part', 'tools'), []);
  assert.equal(parts(html, 'data-part', 'models').length, 1);
  assert.equal(parts(html, 'data-part', 'session').length, 1);
});

test('Session screen of an agent without a session', async () => {
  const { html } = await sessionOf([{ project: 'api', name: 'main', agents: ['working'], harness: 'codex', title: 'Port the parser' }]);

  const [header] = parts(html, 'data-part', 'header');
  assert.match(header, /<b class="title[^"]*">Port the parser<\/b>/);
  assert.match(text(parts(header, 'class', 'meta')[0]), /^codex · .* · working · /);
  assert.equal(parts(header, 'data-press', 'focus').length, 1);
  assert.deepEqual(['cost', 'tokens', 'calls', 'duration'].map((name) => figure(html, name)), ['n/a', 'n/a', 'n/a', 'n/a']);
  assert.deepEqual(parts(html, 'data-chart'), []);
});

// A guard of the order the spec leaves to the tools of as many calls, no scenario of it: by name.
test('tools of as many calls in the order of their names', async () => {
  const { html } = await sessionOf(ompAgent('Fix the login bug'), {
    prepare: (home) =>
      ompSession(home, join(workspace(home, 'api-main'), 'login'), { title: 'Fix the login bug', calls: [{ at: NOW - MINUTE, output: 10, tools: [...toolCalls('zsh', 2), ...toolCalls('awk', 2)] }] }),
  });

  assert.deepEqual(rows(html, 'tools'), ['awk 2', 'zsh 2']);
});

// A guard of the texts of times as the session screen writes them, no scenario of the spec.
test('times as the session screen writes them', () => {
  setEnv('TZ', 'UTC');
  assert.deepEqual([formatDay(WED_15_33), formatDate(WED_15_33), formatDay('n/a'), formatDate('n/a')], ['Wed 15:33', 'Wed 25 Nov, 15:33', 'n/a', 'n/a']);
  assert.deepEqual([2900, 59_940, 90_000, 'n/a' as const].map(formatSeconds), ['2.9s', '59.9s', '1m 30s', 'n/a']);
});
