// Cards of local Orca agents, built over a temporary home folder that holds the harnesses'
// session files, read by the real read-only programs through the real runner.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentCards } from '../src/agent-cards.ts';
import { GIT_TTL_MS } from '../src/core/git.js';
import { sessionDirSlug } from '../src/core/providers/claude-sources.js';
import { NA, STAT_FIELDS } from '../src/core/providers/index.js';
import { run } from '../src/exec.ts';
import { NOW, agent, cardsOf, opencodeDatabase, sessions, tokensOf, workspace } from './helpers/agent-cards.ts';
import { fixtureText, tempHome } from './helpers/files.ts';
import { recordingRun } from './core/helpers/recording-run.ts';

const GROUPS = ['identity', 'context', 'spend', 'cache', 'activity'];

test('omp agent card', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  sessions(join(home, '.omp/agent/sessions/-work-demo'), { '2026-11-02_s1.jsonl': 'omp/basic.jsonl' });

  const [{ model }] = await cardsOf(home, [agent({ agent: 'omp', path })]);
  const [identity, , spend] = model.groups;

  assert.deepEqual(model.groups.map((group: { id: string }) => group.id), GROUPS);
  assert.equal(identity.harness.value, 'omp');
  assert.equal(identity.model.value, 'claude-sonnet-5.5-1m');
  assert.equal(spend.hero.value, '$0.06');
});

test('Claude Code agent card', async () => {
  const home = tempHome();
  const path = workspace(home, 'app');
  sessions(join(home, '.claude/projects', sessionDirSlug(path)), { 'aaaa.jsonl': 'claude/basic.jsonl' });

  const [{ model }] = await cardsOf(home, [agent({ agent: 'claude', path })]);
  const [identity] = model.groups;

  assert.deepEqual(model.groups.map((group: { id: string }) => group.id), GROUPS);
  assert.equal(identity.harness.value, 'Claude Code');
  assert.equal(identity.model.value, 'claude-opus-4-6');
  assert.equal(tokensOf(model), '181k');
});

test('opencode agent card', async () => {
  const home = tempHome();
  opencodeDatabase(home);

  // the fixture's sessions are of the folder /work/demo
  const [{ model }] = await cardsOf(home, [agent({ agent: 'opencode', path: '/work/demo' })]);
  const [identity, , spend] = model.groups;

  assert.deepEqual(model.groups.map((group: { id: string }) => group.id), GROUPS);
  assert.equal(identity.harness.value, 'opencode');
  assert.equal(identity.model.value, 'model-b');
  assert.equal(spend.hero.value, '$0.41');
});

test('Agent without a provider', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');

  const [{ card, model }] = await cardsOf(home, [agent({ agent: 'codex', path })]);

  assert.equal(model.groups[0].harness.value, 'codex');
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

  const [{ model }] = await cardsOf(home, [agent({ agent: 'omp', state: 'waiting', path })]);

  assert.equal(model.groups[0].status.label, 'waiting');
});

test('omp title prefixes dropped', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  const agents = [
    agent({ id: 't1', agent: 'omp', title: 'π > Write the docs', path }),
    agent({ id: 't2', agent: 'omp', title: 'π - Fix the login bug', path }),
  ];

  const models = (await cardsOf(home, agents)).map(({ model }) => model);

  // the title line and the Session row both show the identity group's session figure
  assert.deepEqual(models.map((model) => model.groups[0].session?.value), ['Write the docs', 'Fix the login bug']);
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
