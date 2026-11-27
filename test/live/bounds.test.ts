// What a session answer carries is bounded: each series of a session of 5,000 model calls with
// 90 sub-agents holds at most SERIES_POINTS points, and the whole answer stays under Orca's limit
// of 1 MiB, while its tokens series still adds up to every token the session's own calls logged.
// Drawn from the real worker's answer over an omp session and its sub-agents' transcripts under a
// temporary home (test/helpers/live.ts), asked again until every transcript is read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERIES_POINTS } from '../../src/core/series.js';
import { NOW } from '../helpers/agent-cards.ts';
import { FIX, folderOf, type OmpCall, ompSession, ompSubAgent, sessionOf, toolCalls } from '../helpers/live.ts';

const CALLS = 5000;
const SUB_AGENTS = 90;

// The `i`th of the session's own model calls, a second apart, ending a minute before NOW.
const call = (i: number): OmpCall => ({
  at: NOW - 60_000 - (CALLS - i) * 1000,
  read: 40_000 + i,
  write: i % 7,
  uncached: 10 + (i % 3),
  output: 100 + (i % 11),
  cost: 0.001,
  context: 40_000 + i,
  tools: i % 10 === 0 ? toolCalls('bash', 1) : [],
});

test('Session of 5,000 model calls', async () => {
  const calls = Array.from({ length: CALLS }, (_, i) => call(i));
  const { answer } = await sessionOf([FIX], {
    allRead: true,
    prepare: (home) => {
      const path = folderOf(home, FIX);
      ompSession(home, path, { title: 'Fix the login bug', calls });
      for (let i = 0; i < SUB_AGENTS; i += 1) {
        const at = NOW - 3_600_000 + i * 30_000;
        ompSubAgent(home, path, `Impl${i + 1}`, { init: { at, kind: 'implementer' }, calls: [{ at: at + 1000, read: 1000, output: 10, cost: 0.01 }] });
      }
    },
  });

  const session = answer.session!;
  assert.equal(session.card.reading, null);
  assert.equal(session.subAgents?.total, SUB_AGENTS);
  const series = { tokens: session.tokens!.points, context: session.context!.points, own: session.cost!.own, sub: session.cost!.sub };
  for (const [name, points] of Object.entries(series)) {
    assert.ok(Array.isArray(points), `${name} is n/a`);
    assert.ok(points.length > 0 && points.length <= SERIES_POINTS, `${name}: ${points.length} points`);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) < 1_048_576);
  const summed = session.tokens!.points.reduce((sum, { read, write, uncached, output }) => sum + read + write + uncached + output, 0);
  const logged = calls.reduce((sum, { read = 0, write = 0, uncached = 0, output = 0 }) => sum + read + write + uncached + output, 0);
  assert.equal(summed, logged);
});
