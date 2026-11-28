// The Trace lanes each harness reader keeps of a session in its insights (src/core/insights.js):
// thinking, its model calls; tools, its tool calls; busy, both but the tool calls that start or
// await sub-agents; developer, from a reply that ends a turn to the developer's next prompt; each
// at most TRACE_SPANS spans (src/core/trace.js). The entries are shaped as this Mac's omp, Claude
// Code and opencode log them.
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { newInsights } from '../../src/core/insights.js';
import { claudeProvider } from '../../src/core/providers/claude.js';
import { ompProvider } from '../../src/core/providers/omp.js';
import { opencodeInsights } from '../../src/core/providers/opencode.js';
import { historyRowsQuery, SCHEMA_QUERY, select, sessionsIn } from '../../src/core/providers/opencode-sources.js';
import { minus } from '../../src/core/trace.js';
import { run } from '../../src/exec.ts';
import { opencodeSession, sqlText } from '../helpers/agent-cards.ts';
import { tempHome } from '../helpers/files.ts';
import { claudeEntries, MODEL, ompEntries, type OmpCall } from '../helpers/live.ts';
import { expect } from './helpers/expect.ts';

// A time of the tests' day, `hh:mm:ss`, as epoch ms.
const t = (hms: string) => Date.parse(`2026-11-25T${hms}.000Z`);
const HOUR = 60 * 60 * 1000;

// The insights of an omp session that logs `calls`.
const ompInsights = (calls: OmpCall[]) => ompProvider.fold(undefined, ompEntries(calls, [], MODEL), { insights: true }).insights;

// The Trace lanes of the opencode session `session` of `database`, from its history rows.
async function opencodeLanes(database: string, session: string) {
  const sessions = sessionsIn((await select(run, database, SCHEMA_QUERY))!);
  const rows = (await select(run, database, historyRowsQuery(sessions, 0, null, 5000)))!;
  const ins = newInsights();
  opencodeInsights(
    rows.filter((row) => row.sessionId === session),
    ins,
  );
  return ins.lanes;
}

describe('Trace lanes', () => {
  test('Tool calls joined, the long gap kept', () => {
    // 300 tool calls of 1 s, 2 s apart, then one more an hour after the last
    const tool = (from: number): OmpCall => ({ at: from, tools: [{ name: 'read', started: from, answered: from + 1000 }] });
    const calls = Array.from({ length: 300 }, (_, i) => tool(t('10:00:00') + i * 3000));
    const lastEnd = t('10:00:00') + 299 * 3000 + 1000;
    calls.push(tool(lastEnd + HOUR));

    const { spans, totalMs } = ompInsights(calls).lanes.tools;

    expect(spans.length).toBeLessThanOrEqual(240);
    expect(totalMs).toBe(301000);
    expect(spans.filter(([start, end]: number[]) => end > lastEnd && start < lastEnd + HOUR)).toEqual([]);
    expect(spans.at(-1)).toEqual([lastEnd + HOUR, lastEnd + HOUR + 1000]);
  });

  test('a Claude Code call starts at the entry that sent it', () => {
    // the prompt at 10:00:00; the reply's blocks at 10:00:04 and 10:00:06, the second a
    // `tool_use`, answered at 10:00:09; the next reply's last block at 10:00:15
    const entries = claudeEntries(
      '/work/demo',
      [
        { prompted: t('10:00:00'), blocks: [t('10:00:04')], at: t('10:00:06'), output: 10, stop: 'tool_use', tools: [{ name: 'Bash', answered: t('10:00:09') }] },
        { at: t('10:00:15'), output: 10, stop: 'end_turn' },
      ],
      [],
      'claude-opus-4-6',
    );

    const { lanes, firstMs, lastMs } = claudeProvider.fold(undefined, entries, { insights: true }).insights;

    expect(lanes.thinking.spans).toEqual([
      [t('10:00:00'), t('10:00:06')],
      [t('10:00:09'), t('10:00:15')],
    ]);
    expect(lanes.thinking.totalMs).toBe(12000);
    expect(lanes.tools.spans).toEqual([[t('10:00:06'), t('10:00:09')]]);
    expect(lanes.busy.spans).toEqual([[t('10:00:00'), t('10:00:15')]]);
    expect([firstMs, lastMs]).toEqual([t('10:00:00'), t('10:00:15')]);
  });

  test('an opencode tool runs from its state.time.start', async () => {
    const home = tempHome();
    const C = t('10:00:00');
    // current tables: a call of 30 s whose `bash` runs from its `time.ran` and whose `task` starts
    // a sub-agent, then the developer's prompt 20 s after it, and a second call
    const database = opencodeSession(home, '/work/trace', {
      provider: 'p',
      model: 'm',
      cost: 0.2,
      last: C + 60_000,
      calls: [
        {
          uncached: 100,
          read: 0,
          write: 0,
          output: 50,
          took: 30_000,
          prompted: C - 5000,
          tools: [
            { name: 'bash', created: C + 4000, ran: C + 5000, completed: C + 15_000 },
            { name: 'task', created: C + 16_000, ran: C + 17_000, completed: C + 28_000 },
          ],
        },
        { uncached: 100, read: 0, write: 0, output: 50, prompted: C + 50_000 },
      ],
    });
    // legacy tables: a call of 20 s with a `bash` part from its `state.time.start` to its
    // `state.time.end`, and a `read` part with no end, which ends with its message
    const L = t('11:00:00');
    const legacy = [
      `INSERT INTO session VALUES ('ses_old', 'prj', NULL, 's', '/work/old', 't', '1.0.0', ${L}, ${L + 20_000}, NULL, 0.1);`,
      `INSERT INTO message VALUES ('o1', 'ses_old', ${L}, ${L + 20_000}, ${sqlText(JSON.stringify({ role: 'assistant', modelID: 'm', providerID: 'p', cost: 0.1, tokens: { total: 150, input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: L, completed: L + 20_000 } }))});`,
      `INSERT INTO part VALUES ('po1', 'o1', 'ses_old', ${L + 2000}, ${L + 8000}, ${sqlText(JSON.stringify({ type: 'tool', callID: 't1', tool: 'bash', state: { status: 'completed', time: { start: L + 2000, end: L + 8000 } } }))});`,
      `INSERT INTO part VALUES ('po2', 'o1', 'ses_old', ${L + 9000}, ${L + 9000}, ${sqlText(JSON.stringify({ type: 'tool', callID: 't2', tool: 'read', state: { status: 'running', time: { start: L + 9000 } } }))});`,
    ];
    execFileSync('sqlite3', [database, legacy.join('\n')]);

    const current = await opencodeLanes(database, 'ses_window');
    // a call's model call ends where its first tool starts
    expect(current.thinking.spans).toEqual([
      [C, C + 5000],
      [C + 60_000, C + 61_000],
    ]);
    expect(current.tools.spans).toEqual([
      [C + 5000, C + 15_000],
      [C + 17_000, C + 28_000],
    ]);
    // `task` starts a sub-agent: no busy time
    expect(current.busy.spans).toEqual([
      [C, C + 15_000],
      [C + 60_000, C + 61_000],
    ]);
    expect(current.developer.spans).toEqual([[C + 30_000, C + 50_000]]);

    const old = await opencodeLanes(database, 'ses_old');
    expect(old.thinking.spans).toEqual([[L, L + 2000]]);
    expect(old.tools.spans).toEqual([
      [L + 2000, L + 8000],
      [L + 9000, L + 20_000],
    ]);
  });

  test('a prompt attributed to an agent is no return', () => {
    // a turn ends at 10:00:30; an agent's message wakes the session at 10:02:00, whose reply ends
    // the turn at 10:02:10; the developer's prompt comes at 10:05:30
    const insights = ompInsights([
      { prompted: t('10:00:00'), started: t('10:00:00'), at: t('10:00:30'), output: 10, stop: 'stop' },
      { prompted: t('10:02:00'), promptedBy: 'agent', started: t('10:02:00'), at: t('10:02:10'), output: 10, stop: 'stop' },
      { prompted: t('10:05:30'), started: t('10:05:30'), at: t('10:05:40'), output: 10, stop: 'stop' },
    ]);

    expect(insights.lanes.developer.spans).toEqual([[t('10:02:10'), t('10:05:30')]]);
    expect(insights.lanes.developer.totalMs).toBe(200_000);
    expect(insights.lanes.thinking.spans).toEqual([
      [t('10:00:00'), t('10:00:30')],
      [t('10:02:00'), t('10:02:10')],
      [t('10:05:30'), t('10:05:40')],
    ]);
  });

  test('a late tool across joined gaps adds their time', () => {
    // 241 tools of 1 s, 2 s apart: the first gap, [1 s, 3 s], is joined; then one tool from the
    // first's start to 10 s later, its start logged when it started and its result 800 s later,
    // which covers that joined gap and two gaps not joined, [4 s, 6 s] and [7 s, 9 s]
    const tool = (from: number, to: number, at = to): OmpCall => ({ at, tools: [{ name: 'read', started: from, answered: to }] });
    const T0 = t('10:00:00');
    const calls = Array.from({ length: 241 }, (_, i) => tool(T0 + i * 3000, T0 + i * 3000 + 1000));
    calls.push(tool(T0, T0 + 10_000, T0 + 800_000));
    const entries: { data?: { toolCallId?: string } }[] = ompEntries(calls, [], MODEL);
    const lateStart = entries.findIndex((entry) => entry.data?.toolCallId === 'call-241-0');
    entries.unshift(...entries.splice(lateStart, 1));

    // 241 s of tools, and the 6 s of [0, 10 s] no tool covered
    expect(ompProvider.fold(undefined, entries, { insights: true }).insights.lanes.tools.totalMs).toBe(247_000);
  });

  test('the joined gaps no later span can reach are dropped', () => {
    // 2000 tools of 1 s, 2 s apart, each logged as it ran: past 240 spans, each one joins a gap;
    // in omp, the 1001st is still running
    const from = (i: number) => t('10:00:00') + i * 3000;
    const ompCalls = Array.from({ length: 2000 }, (_, i): OmpCall => ({ at: from(i), tools: [{ name: 'read', started: from(i), answered: from(i) + 1000 }] }));
    const ompLines: { message?: { toolCallId?: string } }[] = ompEntries(ompCalls, [], MODEL);
    const running = ompLines.filter((entry) => entry.message?.toolCallId !== 'call-1000-0');
    const omp = ompProvider.fold(undefined, running, { insights: true }).insights;
    const claudeCalls = Array.from({ length: 2000 }, (_, i) => ({ at: from(i), output: 10, stop: 'tool_use', tools: [{ name: 'Bash', answered: from(i) + 1000 }] }));
    const claude = claudeProvider.fold(undefined, claudeEntries('/work/demo', claudeCalls, [], 'claude-opus-4-6'), { insights: true }).insights;

    // omp keeps only the gaps the running tool can still cover; Claude Code, none
    expect(omp.lanes.tools.gaps.length).toBeGreaterThan(0);
    expect(omp.lanes.tools.gaps[0][1]).toBeGreaterThan(from(1000));
    expect(omp.lanes.tools.totalMs).toBe(1_999_000);
    expect(Object.values(claude.lanes).map((lane: { gaps: unknown[] }) => lane.gaps)).toEqual([[], [], [], []]);
    expect(claude.lanes.tools.totalMs).toBe(2_000_000);
  });

  test("the Trace runs from the session's first entry to its last", () => {
    const entries = [
      { type: 'session', timestamp: '2026-11-25T09:59:00.000Z', cwd: '/work/demo' },
      ...ompEntries([{ prompted: t('10:00:00'), started: t('10:00:00'), at: t('10:00:30'), output: 10, stop: 'stop' }], [], MODEL),
      { type: 'session_exit', timestamp: '2026-11-25T10:01:00.000Z' },
    ];

    const { firstMs, lastMs } = ompProvider.fold(undefined, entries, { insights: true }).insights;

    expect([firstMs, lastMs]).toEqual([t('09:59:00'), t('10:01:00')]);
  });

  test('an opencode step that calls tools ends no turn, one with no finish does', async () => {
    const C = t('10:00:00');
    // a step that finished calling tools, then a prompt before a step with no `finish` (an
    // aborted or failed turn), then a prompt before the next step
    const database = opencodeSession(tempHome(), '/work/steps', {
      provider: 'p',
      model: 'm',
      cost: 0.2,
      last: C + 120_000,
      calls: [
        { uncached: 100, read: 0, write: 0, output: 50, finish: 'tool-calls' },
        { uncached: 100, read: 0, write: 0, output: 50, prompted: C + 30_000, finish: null },
        { uncached: 100, read: 0, write: 0, output: 50, prompted: C + 90_000 },
      ],
    });

    expect((await opencodeLanes(database, 'ses_window')).developer.spans).toEqual([[C + 61_000, C + 90_000]]);
  });

  test('waiting on a sub-agent is its run less the busy time', () => {
    expect(minus([[t('10:00:01'), t('10:10:00')]], [[t('10:04:00'), t('10:04:10')]])).toEqual([
      [t('10:00:01'), t('10:04:00')],
      [t('10:04:10'), t('10:10:00')],
    ]);
  });
});
