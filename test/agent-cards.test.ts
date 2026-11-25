// Cards of local Orca agents, built over a temporary home folder that holds the harnesses'
// session files, read by the real read-only programs through the real runner.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentCards } from '../src/agent-cards.ts';
import { GIT_TTL_MS } from '../src/core/git.js';
import { NA, STAT_FIELDS } from '../src/core/providers/index.js';
import { run } from '../src/exec.ts';
import { NOW, agent, cardsOf, fixture, sessions, tempHome, workspace } from './helpers/agent-cards.ts';

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
  sessions(join(home, '.claude/projects', path.replace(/[^a-zA-Z0-9]/g, '-')), { 'aaaa.jsonl': 'claude/basic.jsonl' });

  const [{ model }] = await cardsOf(home, [agent({ agent: 'claude', path })]);
  const [identity, , spend] = model.groups;

  assert.deepEqual(model.groups.map((group: { id: string }) => group.id), GROUPS);
  assert.equal(identity.harness.value, 'Claude Code');
  assert.equal(identity.model.value, 'claude-opus-4-6');
  assert.equal(spend.figures.find((entry: { label: string }) => entry.label === 'Tokens')?.value, '181k');
});

test('opencode agent card', async () => {
  const home = tempHome();
  const dir = join(home, '.local/share/opencode');
  mkdirSync(dir, { recursive: true });
  execFileSync('sh', ['-c', 'sqlite3 "$1" < "$2"', 'sh', join(dir, 'opencode.db'), fixture('opencode/basic.sql')]);

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
  // a first line that is no title entry
  writeFileSync(join(dir, '2026-11-02_s1.jsonl'), `\n${readFileSync(fixture('omp/basic.jsonl'), 'utf8')}`);
  const heads: string[][] = [];
  const cards = createAgentCards({
    run: (command, args, options) => {
      if (command === 'head') heads.push(args);
      return run(command, args, options);
    },
    home,
  });
  // a session id lists the folder, which reads each file's title
  const agents = [agent({ agent: 'omp', sessionId: 'elsewhere', path })];

  await cards.build(agents, NOW);
  await cards.build(agents, NOW + 1);

  assert.equal(heads.length, 1);
});
