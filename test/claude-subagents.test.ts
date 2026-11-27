// The sub-agents of Claude Code sessions: the transcripts in the `subagents` folder of the folder
// named after a session's id, each named by the meta file beside it, found by one listing and
// read like session files, by the real read-only programs through the real runner, over a
// temporary home folder.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { sessionDirSlug } from '../src/core/providers/claude-sources.js';
import { run, type Run } from '../src/exec.ts';
import { claudeAssistant, claudeUsage } from './core/helpers/entries.ts';
import { agent, cardsOf, refreshing, workspace } from './helpers/agent-cards.ts';
import { tempHome } from './helpers/files.ts';

// A Claude Code session of the folder `path` under `home` with the id `9f799237`, whose own
// model calls logged 100,000 tokens, and its sub-agent `a1`, whose model calls logged 74,880
// tokens, with the meta file Claude Code writes beside its transcript: the transcript's and the
// meta file's paths.
function sessionWithSubAgent(home: string, path: string) {
  const dir = join(home, '.claude/projects', sessionDirSlug(path));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '9f799237.jsonl'), `${claudeAssistant('2026-11-25T11:00:00.000Z', 'msg_s1', claudeUsage(10_000, 10_000, 70_000, 10_000))}\n`);
  const transcript = join(dir, '9f799237/subagents/agent-a1.jsonl');
  mkdirSync(dirname(transcript), { recursive: true });
  const calls = [
    claudeAssistant('2026-11-25T11:10:00.000Z', 'msg_a1', claudeUsage(880, 4_000, 30_000, 10_000), 'claude-haiku-4-5'),
    claudeAssistant('2026-11-25T11:11:00.000Z', 'msg_a2', claudeUsage(0, 2_000, 28_000, 0), 'claude-haiku-4-5'),
  ];
  writeFileSync(transcript, calls.map((line) => `${line}\n`).join(''));
  const meta = join(dirname(transcript), 'agent-a1.meta.json');
  writeFileSync(meta, JSON.stringify({ agentType: 'claude', description: 'Install k3s on jeff-ubuntu', toolUseId: 'toolu_1', spawnDepth: 1, model: 'haiku' }));
  return { transcript, meta };
}

const claudeAgent = (path: string) => agent({ agent: 'claude', sessionId: '9f799237', path });

// A card builder over `home` whose runs are recorded (see `refreshing`), and the `cat`s of
// `path` they ran so far.
function recordingRefresh(home: string) {
  const ran: string[][] = [];
  const recording: Run = (command, args, options) => {
    ran.push([command, ...args]);
    return run(command, args, options);
  };
  const catsOf = (path: string) => ran.filter(([command, ...args]) => command === 'cat' && args.includes(path));
  return { refresh: refreshing(home, recording), catsOf };
}

test('a Claude Code session lists its sub-agent transcripts with their meta', async () => {
  const home = tempHome();
  const path = workspace(home, 'infra');
  sessionWithSubAgent(home, path);

  const [{ card }] = await cardsOf(home, [claudeAgent(path)]);

  assert.deepEqual([card.subAgents!.total, card.subAgents!.read], [1, 1]);
  const [sub] = card.subAgents!.agents;
  assert.deepEqual(
    { name: sub.name, kind: sub.kind, model: sub.model, running: sub.running },
    { name: 'Install k3s on jeff-ubuntu', kind: 'claude', model: 'haiku', running: null },
  );
  assert.equal(sub.stats.totalTokens, 74880);
});

test('a meta file is read once', async () => {
  const home = tempHome();
  const path = workspace(home, 'infra');
  const { meta } = sessionWithSubAgent(home, path);
  const { refresh, catsOf } = recordingRefresh(home);
  await refresh([claudeAgent(path)]);
  assert.equal(catsOf(meta).length, 1);

  const [{ card }] = await refresh([claudeAgent(path)]);

  assert.equal(catsOf(meta).length, 1);
  assert.equal(card.subAgents!.agents[0].name, 'Install k3s on jeff-ubuntu');
});

test('a sub-agent without a meta file is named by its transcript', async () => {
  const home = tempHome();
  const path = workspace(home, 'infra');
  const { meta } = sessionWithSubAgent(home, path);
  rmSync(meta);
  const { refresh, catsOf } = recordingRefresh(home);
  await refresh([claudeAgent(path)]);
  const before = catsOf(meta).length;

  const [{ card }] = await refresh([claudeAgent(path)]);

  assert.equal(catsOf(meta).length, before);
  assert.equal(card.subAgents!.agents[0].name, 'agent-a1');
});

test('a sub-agent whose transcript cannot be read is not read yet', async () => {
  const home = tempHome();
  const path = workspace(home, 'infra');
  const { transcript } = sessionWithSubAgent(home, path);
  chmodSync(transcript, 0o000);
  try {
    const [{ card }] = await cardsOf(home, [claudeAgent(path)]);

    assert.deepEqual([card.subAgents!.total, card.subAgents!.read], [1, 0]);
  } finally {
    chmodSync(transcript, 0o644);
  }
});
