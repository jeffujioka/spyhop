// Cards of local Orca agents, built over a temporary home folder that holds the harnesses'
// session files, read by the real read-only programs through the real runner.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentCards } from '../src/agent-cards.ts';
import { GIT_TTL_MS } from '../src/core/git.js';
import { sessionDirSlug } from '../src/core/providers/claude-sources.js';
import { formatHomePath } from '../src/core/format.js';
import { NA, STAT_FIELDS } from '../src/core/providers/index.js';
import { TAIL_BYTES } from '../src/core/refresh.js';
import { run } from '../src/exec.ts';
import { NOW, agent, cardsOf, costOf, costTurn, ompSessionOf, opencodeDatabase, sessions, tokensOf, workspace } from './helpers/agent-cards.ts';
import { fixtureText, tempHome } from './helpers/files.ts';
import { recordingRun } from './core/helpers/recording-run.ts';

test('omp agent card', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  // basic.jsonl's own session id, in the name omp gives the file
  const sessionId = '00000000-0000-7000-8000-000000000001';
  sessions(join(home, '.omp/agent/sessions/-work-demo'), { [`2026-11-02_${sessionId}.jsonl`]: 'omp/basic.jsonl' });

  const [{ view }] = await cardsOf(home, [agent({ agent: 'omp', sessionId, path })]);

  assert.equal(view.harness, 'omp');
  assert.equal(view.model, 'claude-sonnet-5.5-1m');
  assert.equal(costOf(view), '$0.06');
});

test('Claude Code agent card', async () => {
  const home = tempHome();
  const path = workspace(home, 'app');
  sessions(join(home, '.claude/projects', sessionDirSlug(path)), { 'aaaa.jsonl': 'claude/basic.jsonl' });

  const [{ card, view }] = await cardsOf(home, [agent({ agent: 'claude', path })]);

  assert.equal(view.harness, 'Claude Code');
  assert.equal(view.model, 'claude-opus-4-6');
  assert.equal(tokensOf(card), '181k');
});

test('opencode agent card', async () => {
  const home = tempHome();
  opencodeDatabase(home);

  // the fixture's sessions are of the folder /work/demo
  const [{ view }] = await cardsOf(home, [agent({ agent: 'opencode', path: '/work/demo' })]);

  assert.equal(view.harness, 'opencode');
  assert.equal(view.model, 'model-b');
  assert.equal(costOf(view), '$0.41');
});

test('Agent without a provider', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');

  const [{ card, view }] = await cardsOf(home, [agent({ agent: 'codex', path })]);

  assert.equal(view.harness, 'codex');
  assert.deepEqual(STAT_FIELDS.filter((field: string) => card.stats[field] !== NA), []);
});

test('Folder without a session file', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  // a session of another folder is not this folder's
  sessions(join(home, '.omp/agent/sessions/-work-other'), { 's1.jsonl': 'omp/basic.jsonl' });

  const [{ card }] = await cardsOf(home, [agent({ agent: 'omp', path })]);

  assert.deepEqual(STAT_FIELDS.filter((field: string) => card.stats[field] !== NA), []);
});

test('Session file with no agent', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  sessions(join(home, '.omp/agent/sessions/-work-demo'), { 's1.jsonl': 'omp/basic.jsonl', 's2.jsonl': 'omp/compacted.jsonl' });

  const cards = await cardsOf(home, [agent({ agent: 'omp', path })]);

  assert.equal(cards.length, 1);
});

test('Agent state on the card', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');

  const [{ view }] = await cardsOf(home, [agent({ agent: 'omp', state: 'waiting', path })]);

  assert.equal(view.state, 'waiting');
});

test('omp title prefixes dropped', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  const agents = [
    agent({ id: 't1', agent: 'omp', title: 'π > Write the docs', path }),
    agent({ id: 't2', agent: 'omp', title: 'π - Fix the login bug', path }),
  ];

  const views = (await cardsOf(home, agents)).map(({ view }) => view);

  assert.deepEqual(views.map((view) => view.title), ['Write the docs', 'Fix the login bug']);
});

test("Orca's title marks dropped", async () => {
  const home = tempHome();
  const path = workspace(home, 'boto');
  const agents = [
    agent({ id: 't1', agent: 'omp', title: 'π ⠿ Add quadrant mode - boto', path }),
    agent({ id: 't2', agent: 'omp', state: 'blocked', title: 'π ! Fix the login bug - boto', path }),
    agent({ id: 't3', agent: 'omp', state: 'done', title: 'OMP > Write the docs', path }),
  ];

  const views = (await cardsOf(home, agents)).map(({ view }) => view);

  assert.deepEqual(views.map((view) => view.title), ['Add quadrant mode', 'Fix the login bug', 'Write the docs']);
});

test('Git asked again only after GIT_TTL_MS', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path });
  // one builder over refreshes, as the worker keeps it
  const cards = createAgentCards({ run, home });
  const agents = [agent({ agent: 'omp', path })];

  assert.equal((await cards.build(agents, NOW))[0].branch, 'main');
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/other'], { cwd: path });
  assert.equal((await cards.build(agents, NOW + GIT_TTL_MS - 1))[0].branch, 'main');
  assert.equal((await cards.build(agents, NOW + GIT_TTL_MS))[0].branch, 'other');
});

test('Card without a linked session keeps the workspace folder', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path });

  const [{ card, view }] = await cardsOf(home, [agent({ agent: 'omp', path })]);

  assert.equal(formatHomePath(card.folder, home), '~/work/demo');
  assert.equal(view.branch, 'main');
  assert.deepEqual(STAT_FIELDS.filter((field: string) => card.stats[field] !== NA), []);
});

test('Session that records no folder keeps the workspace folder', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  const file = ompSessionOf(home, path);
  // its `session` entry holds no `cwd`
  writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-11-25T11:58:00.000Z' })}\n${costTurn(0.1)}`);
  const { exec, calls } = recordingRun();
  const cards = createAgentCards({ run: exec, home });
  const agents = [agent({ agent: 'omp', sessionId: 's1', path })];

  const [card] = await cards.build(agents, NOW);
  await cards.build(agents, NOW + 1);

  assert.equal(card.stats.costUsd, 0.1);
  assert.equal(card.folder, path);
  // the file is whole in the window a refresh reads, which shows that it records none
  assert.equal(calls.filter(({ command }) => command === 'head').length, 0);
});

test('Session that records a relative folder keeps the workspace folder', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  const file = ompSessionOf(home, path);
  // git would run in a relative folder below the plugin's own process folder
  const session = { type: 'session', version: 3, id: 's1', timestamp: '2026-11-25T11:58:00.000Z', cwd: 'work/demo' };
  writeFileSync(file, `${JSON.stringify(session)}\n${costTurn(0.1)}`);

  const [{ card }] = await cardsOf(home, [agent({ agent: 'omp', sessionId: 's1', path })]);

  assert.equal(card.stats.costUsd, 0.1);
  assert.equal(card.folder, path);
});

test('Folder of a session larger than the window read once', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  const sub = join(path, 'sub');
  const file = ompSessionOf(home, sub);
  // the `session` entry, at the head of the file, is outside the window a refresh reads
  const session = { type: 'session', version: 3, id: 's1', timestamp: '2026-11-25T11:58:00.000Z', cwd: sub };
  writeFileSync(file, `${JSON.stringify(session)}\n${JSON.stringify({ type: 'custom', note: 'x'.repeat(TAIL_BYTES) })}\n${costTurn(0.1)}`);
  const { exec, calls } = recordingRun();
  const cards = createAgentCards({ run: exec, home });
  const agents = [agent({ agent: 'omp', sessionId: 's1', path })];

  const [card] = await cards.build(agents, NOW);
  appendFileSync(file, costTurn(0.1));
  const [later] = await cards.build(agents, NOW + 1);

  assert.deepEqual([card.folder, later.folder], [sub, sub]);
  assert.equal(later.stats.costUsd, 0.2);
  assert.equal(calls.filter(({ command }) => command === 'head').length, 1);
});

test('Unreadable omp title read once per file change', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  const dir = join(home, '.omp/agent/sessions/-work-demo');
  mkdirSync(dir, { recursive: true });
  // a first line that is no title entry, beside a session with a title
  writeFileSync(join(dir, '2026-11-02_s1.jsonl'), `\n${fixtureText('omp/basic.jsonl')}`);
  writeFileSync(join(dir, '2026-11-02_s2.jsonl'), fixtureText('omp/basic.jsonl'));
  const { exec, calls } = recordingRun();
  const cards = createAgentCards({ run: exec, home });
  // two agents share the folder's sessions out by title, which reads each file's title
  const agents = [agent({ id: 't1', agent: 'omp', path }), agent({ id: 't2', agent: 'omp', path })];

  await cards.build(agents, NOW);
  await cards.build(agents, NOW + 1);

  assert.equal(calls.filter(({ command }) => command === 'head').length, 2);
});
