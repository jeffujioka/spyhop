// The series of a session for the card and the session screen: the contexts of the last model
// calls, which the card's spark line draws (the bounded list `pushRecent` keeps, and the
// `detail.recent` each provider's `readStats` gives beside its stats, from the whole session
// only), and the bounded series of every model call that `addCall` keeps, in which a response
// written again takes the place of its first version, and `groupPoints` fits to a chart.
import { describe, test } from 'node:test';
import { readStats } from '../../src/core/providers/index.js';
import { SERIES_POINTS, SPARK_CALLS, addCall, groupPoints, newSeries, pushRecent } from '../../src/core/series.js';
import { NOW, claudeAssistant, claudeUsage, ompMessage } from './helpers/entries.ts';
import { expect } from './helpers/expect.ts';

// 12 omp assistant messages whose prompts held 1000, 2000, … 12000 tokens, as jsonl lines; each
// logs its output, as a model call that answered does.
const ompCalls = Array.from({ length: 12 }, (_, i) =>
  ompMessage('assistant', `2026-11-02T11:${String(i).padStart(2, '0')}:00.000Z`, { output: 10 }, { contextSnapshot: { promptTokens: (i + 1) * 1000 } }),
);

describe('series: the contexts of the last model calls', () => {
  test('the spark keeps the contexts of the last 30 model calls', () => {
    let recent: number[] = [];
    for (let context = 1; context <= 40; context += 1) recent = pushRecent(recent, context);

    expect(SPARK_CALLS).toBe(30);
    expect(recent).toEqual(Array.from({ length: 30 }, (_, i) => i + 11));
  });

  test('an omp file gives the context of each model call', () => {
    const header = JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-11-02T10:59:00.000Z', cwd: '/w' });
    const whole = readStats('omp', [header, ompMessage('user', '2026-11-02T10:59:30.000Z'), ...ompCalls].join('\n'), NOW);
    // the same lines without the `session` entry: a tail window, not the whole file
    const tail = readStats('omp', ompCalls.join('\n'), NOW);

    expect(whole.detail.recent).toEqual(Array.from({ length: 12 }, (_, i) => (i + 1) * 1000));
    expect(tail.detail).toBeNull();
  });

  test('a Claude Code response written as three blocks is one model call', () => {
    const lines = [
      claudeAssistant('2026-11-02T11:00:00.000Z', 'r1', claudeUsage(10, 5, 100, 20)),
      // the three content blocks of the response r2, each with the response's usage
      ...['01', '02', '03'].map((s) => claudeAssistant(`2026-11-02T11:01:${s}.000Z`, 'r2', claudeUsage(30, 7, 400, 50))),
    ];

    const stats = readStats('claude-code', { text: lines.join('\n'), sources: { wholeFile: true } }, NOW);

    // input + cache read + cache write of each response
    expect(stats.detail.recent).toEqual([130, 480]);
  });

  test('opencode rows give the context of each assistant message', () => {
    const row = (id: string, role: string, input: number | null, cacheRead: number | null, cacheWrite: number | null) => ({
      id,
      role,
      parentId: null,
      created: 1790000000000,
      completed: role === 'assistant' ? 1790000001000 : null,
      modelId: role === 'assistant' ? 'model-a' : null,
      variant: null,
      summary: null,
      cost: null,
      total: null,
      input,
      output: role === 'assistant' ? 9 : null,
      reasoning: null,
      cacheRead,
      cacheWrite,
    });
    const messages = [row('u1', 'user', null, null, null), row('a1', 'assistant', 10, 200, 30), row('u2', 'user', null, null, null), row('a2', 'assistant', 20, 500, 40)];

    const stats = readStats('opencode', { messages, compactions: null }, NOW);

    expect(stats.detail).toEqual({ recent: [240, 560] });
  });
});

describe('series: the model calls of the whole session', () => {
  test('a full series merges neighbours and keeps every call', () => {
    const calls = Array.from({ length: 121 }, (_, i) => ({ t: i, read: i, write: 2 * i, uncached: 1, output: 3, cost: 0.5, context: 1000 + i }));
    const series = newSeries();
    for (const call of calls) addCall(series, call);

    expect(SERIES_POINTS).toBe(120);
    expect(series.width).toBe(2);
    expect(series.points).toHaveLength(61);
    expect(series.points.slice(0, 60).every((point) => point.n === 2)).toBe(true);
    // each pair is dated and sized by its later call
    expect(series.points[0]).toEqual({ t: 1, n: 2, read: 1, write: 2, uncached: 2, output: 6, cost: 1, context: 1001 });
    expect(series.points[60]).toEqual({ ...calls[120], n: 1 });
    const sum = (key: string, list: Record<string, number>[]) => list.reduce((total, item) => total + item[key], 0);
    for (const key of ['n', 'read', 'write', 'uncached', 'output', 'cost']) {
      expect(sum(key, series.points)).toBe(key === 'n' ? 121 : sum(key, calls));
    }
  });

  test('a Claude Code response written again in a point of two calls is counted once', () => {
    const at = (i: number, s = 0) => new Date(Date.parse('2026-11-02T09:00:00.000Z') + i * 10_000 + s * 1000).toISOString();
    // 121 responses fill the series and halve it, so the 122nd shares the last point with the
    // 121st; it is written as three blocks, the last with the output it ended with
    const lines = [
      ...Array.from({ length: 121 }, (_, i) => claudeAssistant(at(i), `r${i}`, claudeUsage(1, 2, 10, 0))),
      ...[2, 5, 9].map((output, s) => claudeAssistant(at(121, s), 'r121', claudeUsage(1, output, 10, 0))),
    ];

    const { points } = readStats('claude-code', { text: lines.join('\n'), sources: { wholeFile: true } }, NOW).detail;

    expect(points).toHaveLength(61);
    // the 121st response, and the 122nd as its last block logged it, once
    expect(points[60]).toMatchObject({ t: Date.parse(at(121, 2)), n: 2, read: 20, write: 0, uncached: 2, output: 11, context: 11 });
    expect(points.reduce((sum: number, point: { n: number }) => sum + point.n, 0)).toBe(122);
  });

  test('grouped points add their tokens and cost and keep the last context', () => {
    const point = (i: number, cost: number | null) => ({ t: i, n: 1, read: 10 * i, write: i, uncached: 2, output: 5, cost, context: 100 * i });

    const grouped = groupPoints([point(1, 0.1), point(2, 0.2), point(3, 0.3), point(4, null)], 2);

    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toEqual({ t: 2, n: 2, read: 30, write: 3, uncached: 4, output: 10, cost: 0.1 + 0.2, context: 200 });
    // a cost that was not logged leaves the sum of its group unknown
    expect(grouped[1]).toEqual({ t: 4, n: 2, read: 70, write: 7, uncached: 4, output: 10, cost: null, context: 400 });
  });
});
