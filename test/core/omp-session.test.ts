import { describe, test } from 'node:test';
import { NA, readStats } from '../../src/core/providers/index.js';
import { fixtureText } from '../helpers/files.ts';
import { ompMessage } from './helpers/entries.ts';
import { expect } from './helpers/expect.ts';

// One synthetic assistant message entry; `usage` is left out when null.
const assistant = (isoTime, usage, model = 'm') => ompMessage('assistant', isoTime, usage, { model });

describe('omp session: model, duration, tokens and cost', () => {
  test('model, duration and total tokens', () => {
    const stats = readStats('omp', fixtureText('omp/basic.jsonl'), Date.now());

    expect(stats.harness).toBe('omp');
    expect(stats.model).toBe('claude-sonnet-5.5-1m');
    // first message 10:05:41.002Z, last message 10:15:39.629Z
    expect(stats.durationMs).toBe(598627);
    expect(stats.totalTokens).toBe(18078 + 23061 + 16429 + 21210);

    // The model is the latest assistant message's, not the first one's.
    const switched = [
      assistant('2026-11-02T10:00:00.000Z', null, 'model-a'),
      assistant('2026-11-02T10:01:00.000Z', null, 'model-b'),
      assistant('2026-11-02T10:02:00.000Z', null, 'model-c'),
    ].join('\n');
    expect(readStats('omp', switched, Date.now()).model).toBe('model-c');
  });

  test('missing usage field is n/a', () => {
    const stats = readStats('omp', fixtureText('omp/no-usage.jsonl'), Date.now());

    expect(stats.totalTokens).toBe(NA);
    expect(stats.costUsd).toBe(NA);
    // the other figures still show
    expect(stats.model).toBe('claude-sonnet-5.5-1m');
    expect(stats.durationMs).toBe(5031); // 10:05:41.002Z to 10:05:46.033Z
  });

  test('cost sums cost.total', () => {
    const usage = (total) => ({ totalTokens: 10, cost: { total } });
    const text = [
      assistant('2026-11-02T10:00:00.000Z', usage(0.1)),
      assistant('2026-11-02T10:01:00.000Z', usage(0.25)),
      assistant('2026-11-02T10:02:00.000Z', usage(0.15)),
    ].join('\n');

    expect(readStats('omp', text, Date.now()).costUsd).toBeCloseTo(0.5, 10);
  });
});

describe('omp session: the series of the whole session', () => {
  const at = (minute: number) => `2026-11-02T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const whole = (lines: string[]) => readStats('omp', { text: lines.join('\n'), sources: { wholeFile: true } }, Date.now());
  // One model call's usage: prompt tokens read from the cache, written to it and not cached, the
  // output tokens, and the costs it logged, in total and for the cache write.
  const usage = (read: number, write: number, uncached: number, output: number, total = 0.01, cacheWrite = 0) => ({
    input: uncached,
    output,
    cacheRead: read,
    cacheWrite: write,
    totalTokens: read + write + uncached + output,
    cost: { cacheWrite, total },
  });

  test('one point per model call with its prompt kinds', () => {
    const call = (minute: number, u: object, context: number) => ompMessage('assistant', at(minute), u, { contextSnapshot: { promptTokens: context } });
    const stats = whole([
      ompMessage('user', at(0)),
      call(1, usage(0, 40_000, 10_000, 300, 0.5), 50_000),
      call(2, usage(40_000, 10_000, 0, 500, 0.2), 50_000),
      call(3, usage(50_000, 0, 0, 200, 0.1), 50_000),
    ]);

    expect(stats.detail.points).toEqual([
      { t: Date.parse(at(1)), n: 1, read: 0, write: 40_000, uncached: 10_000, output: 300, cost: 0.5, context: 50_000 },
      { t: Date.parse(at(2)), n: 1, read: 40_000, write: 10_000, uncached: 0, output: 500, cost: 0.2, context: 50_000 },
      { t: Date.parse(at(3)), n: 1, read: 50_000, write: 0, uncached: 0, output: 200, cost: 0.1, context: 50_000 },
    ]);
    expect(stats.calls).toBe(3);
    expect(stats.firstMessageMs).toBe(Date.parse(at(0)));
    // a tail window cannot count the session's calls nor tell its first message
    const tail = readStats('omp', [call(3, usage(50_000, 0, 0, 200), 50_000)].join('\n'), Date.now());
    expect(tail.calls).toBe(NA);
    expect(tail.firstMessageMs).toBe(NA);
  });

  test('compactions keep their tokens before and after', () => {
    const compaction = (time: string, tokens: object) => JSON.stringify({ type: 'compaction', timestamp: time, summary: 's', ...tokens });

    const stats = whole([
      assistant(at(1), usage(1, 1, 1, 1)),
      compaction('2026-11-02T12:40:00.000Z', { tokensBefore: 880_000, tokensAfter: 221_000 }),
      compaction('2026-11-02T12:50:00.000Z', {}),
    ]);

    expect(stats.detail.marks).toEqual([
      { t: Date.parse('2026-11-02T12:40:00.000Z'), before: 880_000, after: 221_000 },
      // a compaction that logged no tokens reads n/a for them
      { t: Date.parse('2026-11-02T12:50:00.000Z'), before: null, after: null },
    ]);
  });

  test('a cold start is a call after the first that read nothing', () => {
    const stats = whole([
      assistant(at(1), usage(0, 300_000, 10, 1, 1, 1.1)),
      assistant(at(2), usage(300_000, 10, 10, 1, 0.1, 0.01)),
      assistant(at(3), usage(300_000, 10, 10, 1, 0.1, 0.01)),
      assistant(at(4), usage(0, 600_000, 10, 1, 2.5, 2.25)),
      assistant(at(5), usage(600_000, 10, 10, 1, 0.1, 0.01)),
    ]);

    expect(stats.detail.cold).toEqual({ count: 1, tokens: 600_000, cost: 2.25 });
    // each call after the first read from the cache: no cold start
    const warm = whole([assistant(at(1), usage(0, 300_000, 10, 1)), assistant(at(2), usage(300_000, 10, 10, 1))]);
    expect(warm.detail.cold).toEqual({ count: 0, tokens: 0, cost: 0 });
  });

  test('an aborted call that logged no usage is no model call', () => {
    const call = (minute: number, u: object, extra: object) => ompMessage('assistant', at(minute), u, { model: 'm', ...extra });
    // what omp logs for a call it aborted or that failed before the model answered
    const aborted = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { cacheWrite: 0, total: 0 } };

    const stats = whole([
      call(1, usage(0, 300_000, 10, 1, 1, 1.1), { contextSnapshot: { promptTokens: 300_010 } }),
      call(2, aborted, { stopReason: 'aborted', contextSnapshot: { promptTokens: 0 } }),
      call(3, usage(300_000, 10, 10, 1, 0.1, 0.01), { contextSnapshot: { promptTokens: 300_020 } }),
    ]);

    expect(stats.calls).toBe(2);
    expect(stats.detail.points.map((point: { t: number }) => point.t)).toEqual([Date.parse(at(1)), Date.parse(at(3))]);
    expect(stats.detail.cold).toEqual({ count: 0, tokens: 0, cost: 0 });
    expect(stats.detail.recent).toEqual([300_010, 300_020]);
    expect(stats.detail.models).toEqual({ 'p/m': { cost: 1.1, tokens: 300_011 + 300_021, main: true, side: false } });
  });

  test('tool calls by tool, failures from their results', () => {
    const calling = (minute: number, tools: [string, string][]) =>
      ompMessage('assistant', at(minute), usage(1, 1, 1, 1), { content: tools.map(([id, name]) => ({ type: 'toolCall', id, name, arguments: {} })) });
    const result = (minute: number, id: string, name: string, isError: boolean) =>
      ompMessage('toolResult', at(minute), null, { toolCallId: id, toolName: name, isError, content: [] });

    const stats = whole([
      calling(1, [['c1', 'bash'], ['c2', 'read']]),
      result(2, 'c1', 'bash', false),
      result(2, 'c2', 'read', true),
      calling(3, [['c3', 'bash'], ['c4', 'bash']]),
      result(4, 'c3', 'bash', true),
      result(4, 'c4', 'bash', false),
    ]);

    expect(stats.detail.tools).toEqual({ bash: { calls: 3, failed: 1 }, read: { calls: 1, failed: 1 } });
  });

  test('cost and tokens by the model each call logged', () => {
    const on = (minute: number, model: string, total: number) => ompMessage('assistant', at(minute), usage(100, 0, 0, 10, total), { model });

    const stats = whole([on(1, 'claude-fable-5.2', 0.25), on(2, 'claude-opus-5.5-1m', 0.5), on(3, 'claude-fable-5.2', 0.75)]);

    expect(stats.detail.models).toEqual({
      'p/claude-fable-5.2': { cost: 1, tokens: 220, main: true, side: false },
      'p/claude-opus-5.5-1m': { cost: 0.5, tokens: 110, main: true, side: false },
    });
    // a call that logged no cost leaves its model's cost unknown
    const unknown = whole([on(1, 'm', 0.25), ompMessage('assistant', at(2), { output: 5, totalTokens: 5 }, { model: 'm' })]);
    expect(unknown.detail.models).toEqual({ 'p/m': { cost: null, tokens: 115, main: true, side: false } });
  });
});
