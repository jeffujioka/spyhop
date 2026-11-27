// The sub-agents of omp sessions: the transcripts in the folder beside a session file, found by
// one listing and read like session files, by the real read-only programs through the real
// runner, over a temporary home folder.
import assert from 'node:assert/strict';
import { readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { SUBAGENT_READS_PER_REFRESH } from '../src/core/providers/session-files.js';
import { NOW, PADDING, agent, cardsOf, ompSessionOf, refreshing, subAgentFile, workspace } from './helpers/agent-cards.ts';
import { tempHome } from './helpers/files.ts';

const MODEL = 'github-copilot/claude-opus-5.5-1m';

// The `session_init` entry omp writes near the top of a sub-agent transcript.
const sessionInit = (kind: string, task: string) =>
  `${JSON.stringify({ type: 'session_init', agent: kind, readOnly: false, resolvedModel: MODEL, spawns: '*', task })}\n`;

// A model call at `timestamp` that logged 0.10 USD and ended its turn (`stopReason` `stop`), as
// a line of a transcript.
const callAt = (timestamp: string) =>
  `${JSON.stringify({ type: 'message', timestamp, message: { role: 'assistant', stopReason: 'stop', usage: { totalTokens: 100, cost: { total: 0.1 } } } })}\n`;

// A model call at `timestamp` that logged 0.10 USD and called the tool `read`, which leaves its
// turn open, as a line of a transcript.
const toolCallAt = (timestamp: string) =>
  `${JSON.stringify({ type: 'message', timestamp, message: { role: 'assistant', stopReason: 'toolUse', usage: { totalTokens: 100, cost: { total: 0.1 } }, content: [{ type: 'toolCall', id: 't1', name: 'read' }] } })}\n`;

// The answer of the tool call `toolCallAt` made, at `timestamp`, as a line of a transcript.
const toolResultAt = (timestamp: string) =>
  `${JSON.stringify({ type: 'message', timestamp, message: { role: 'toolResult', toolCallId: 't1', isError: false } })}\n`;

// A message omp gives a sub-agent outside a model call, at `timestamp`, as a line of a transcript.
const customAt = (timestamp: string) => `${JSON.stringify({ type: 'custom_message', timestamp, customType: 'irc', content: 'Go on.' })}\n`;

// The omp session of the folder `path` under `home`, in the file the scenario names; its id is
// `01a21357`.
function namedSession(home: string, path: string) {
  const file = ompSessionOf(home, path);
  const named = join(dirname(file), '2026-11-25T15-33-32-885Z_01a21357.jsonl');
  renameSync(file, named);
  return named;
}

test('Folder beside an omp session file', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  // the session's `session` entry is at 11:58
  const file = namedSession(home, path);
  // larger than the window a refresh reads from a file's end: its kind and model are read on
  // the first refresh all the same
  subAgentFile(file, 'Impl1', [sessionInit('task', 'Build the parser'), PADDING, callAt('2026-11-25T11:59:00.000Z')]);
  subAgentFile(file, 'Rev1', [sessionInit('reviewer', 'Review the parser\nof task 1'), toolCallAt('2026-11-25T11:59:10.000Z'), toolResultAt('2026-11-25T11:59:20.000Z')]);
  const folder = file.replace(/\.jsonl$/, '');
  // the lock file tells nothing: Impl1 has ended
  writeFileSync(join(folder, '.Impl1.jsonl.lock.os'), '');
  writeFileSync(join(folder, 'Impl1.md'), 'Done.\n');
  writeFileSync(join(folder, 'changes.jsonl'), `${JSON.stringify({ agent: 'Impl1', at: NOW, path: 'a.ts', tool: 'edit', type: 'edit' })}\n`);

  const [{ card }] = await cardsOf(home, [agent({ sessionId: '01a21357', path })]);

  const agents = card.subAgents!.agents.map(({ name, kind, model, running }) => ({ name, kind, model, running }));
  assert.deepEqual(agents, [
    { name: 'Impl1', kind: 'task', model: MODEL, running: false },
    { name: 'Rev1', kind: 'reviewer', model: MODEL, running: true },
  ]);
  assert.deepEqual(
    card.subAgents!.agents.map(({ task }) => task),
    [null, 'Review the parser'],
  );
  assert.deepEqual([card.subAgents!.total, card.subAgents!.read], [2, 2]);
});

test('Revived sub-agent', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  const file = namedSession(home, path);
  subAgentFile(file, 'Impl1', [sessionInit('task', 'Build'), callAt('2026-11-25T11:59:00.000Z'), customAt('2026-11-25T11:59:30.000Z')]);

  const [{ card }] = await cardsOf(home, [agent({ sessionId: '01a21357', path })]);

  assert.deepEqual(card.subAgents!.agents.map(({ name, running }) => [name, running]), [['Impl1', true]]);
});

test('Copy from a continued session', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  const file = namedSession(home, path);
  // the session's `session` entry at 02:38:33
  writeFileSync(file, readFileSync(file, 'utf8').replace('"timestamp":"2026-11-25T11:58:00.000Z"', '"timestamp":"2026-11-25T02:38:33.000Z"'));
  subAgentFile(file, 'Impl1', [sessionInit('task', 'Build'), toolCallAt('2026-11-25T02:38:16.000Z')]);

  const [{ card }] = await cardsOf(home, [agent({ sessionId: '01a21357', path })]);

  assert.deepEqual(card.subAgents!.agents.map(({ name, running }) => [name, running]), [['Impl1', false]]);
});

test('a session without a sub-agent folder has no sub-agents', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  namedSession(home, path);

  const [{ card }] = await cardsOf(home, [agent({ sessionId: '01a21357', path })]);

  assert.deepEqual(card.subAgents, { total: 0, read: 0, agents: [] });
});

test('a sub-agent of a sub-agent is listed', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  const file = namedSession(home, path);
  subAgentFile(file, 'Impl1', [sessionInit('task', 'Build'), callAt('2026-11-25T11:10:00.000Z')]);
  subAgentFile(file, 'Impl1/Rev1', [sessionInit('reviewer', 'Review'), callAt('2026-11-25T11:20:00.000Z')]);
  // a folder that is no sub-agent's: no `local.jsonl` beside it
  subAgentFile(file, 'local/notes', [callAt('2026-11-25T11:30:00.000Z')]);

  const [{ card }] = await cardsOf(home, [agent({ sessionId: '01a21357', path })]);

  assert.deepEqual(
    card.subAgents!.agents.map(({ name, kind }) => [name, kind]),
    [
      ['Impl1', 'task'],
      ['Rev1', 'reviewer'],
    ],
  );
});

test('at most 16 new transcripts are read per refresh', async () => {
  const home = tempHome();
  const path = workspace(home, 'demo');
  const file = namedSession(home, path);
  // 20 transcripts, `Impl01` the oldest
  const names = Array.from({ length: 20 }, (_, i) => `Impl${String(i + 1).padStart(2, '0')}`);
  names.forEach((name, i) => {
    const transcript = subAgentFile(file, name, [sessionInit('task', name), callAt('2026-11-25T11:10:00.000Z')]);
    const seconds = NOW / 1000 - 3600 + i * 60;
    utimesSync(transcript, seconds, seconds);
  });
  const refresh = refreshing(home);
  const agents = [agent({ sessionId: '01a21357', path })];

  const [{ card }] = await refresh(agents);

  assert.equal(SUBAGENT_READS_PER_REFRESH, 16);
  assert.deepEqual([card.subAgents!.total, card.subAgents!.read], [20, 16]);
  const unread = card.subAgents!.agents.filter(({ input }) => input === null).map(({ name }) => name);
  assert.deepEqual(unread.sort(), names.slice(0, 4));
  // the next refresh reads the rest
  const [{ card: next }] = await refresh(agents);
  assert.deepEqual([next.subAgents!.total, next.subAgents!.read], [20, 20]);
});
