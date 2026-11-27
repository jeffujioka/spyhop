// The series of a session for the card and the session screen: the contexts of the last model
// calls, which the card's spark line draws (the bounded list `pushRecent` keeps, and the
// `detail.recent` each provider's `readStats` gives beside its stats, from the whole session
// only), the bounded series of every model call that `addCall` keeps, in which a response
// written again takes the place of its first version, and `groupPoints` fits to a chart, and the
// per-minute sums of the newest minutes that `addMinute` keeps, for the burn rate.
import { describe, test } from 'node:test';
import { readStats } from '../../src/core/providers/index.js';
import { MINUTES_KEPT, SERIES_POINTS, SPARK_CALLS, addCall, addMinute, groupPoints, minuteSums, newSeries, pushRecent } from '../../src/core/series.js';
import { MINUTE, NOW, claudeAssistant, claudeUsage, ompMessage } from './helpers/entries.ts';
import { expect } from './helpers/expect.ts';

// The epoch minute of the ISO time `iso`.
const minuteOf = (iso: string) => Math.floor(Date.parse(iso) / MINUTE);

// One opencode message row as the reader gives it, the counts and `extra` (fields such as
// `created`, `cost` and `total`) as given; an assistant's has a model and logs its output.
const opencodeRow = (id: string, role: string, input: number | null, cacheRead: number | null, cacheWrite: number | null, extra: object = {}) => ({
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
  ...extra,
});

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
    const messages = [
      opencodeRow('u1', 'user', null, null, null),
      opencodeRow('a1', 'assistant', 10, 200, 30),
      opencodeRow('u2', 'user', null, null, null),
      opencodeRow('a2', 'assistant', 20, 500, 40),
    ];

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

describe('series: the per-minute sums of the newest minutes', () => {
  test('minutes keep the newest 70', () => {
    const minutes: { m: number }[] = [];
    for (let m = 1; m <= 100; m += 1) {
      const t = m * MINUTE + 30_000;
      addMinute(minutes, t, { t, read: 1, write: 2, uncached: 3, output: 4, cost: 0.5, context: null, tokens: 10 });
    }

    expect(MINUTES_KEPT).toBe(70);
    expect(minutes.map((minute) => minute.m)).toEqual(Array.from({ length: 70 }, (_, i) => i + 31));
    expect(minutes[0]).toEqual({ m: 31, cost: 0.5, tokens: 10, read: 1, write: 2, uncached: 3 });
    // the last 10 minutes, both ends counted
    expect(minuteSums(minutes, 91, 100)).toEqual({ m: 100, cost: 5, tokens: 100, read: 10, write: 20, uncached: 30 });
  });

  test('an entry older than the newest minute still counts', () => {
    const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) => ({
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { total: cost },
    });
    const header = JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-11-02T10:00:00.000Z', cwd: '/w' });
    const lines = [
      header,
      ompMessage('user', '2026-11-02T10:00:10.000Z'),
      ompMessage('assistant', '2026-11-02T11:40:10.000Z', usage(10, 5, 100, 20, 0.5)),
      // a call of minute 95 folded after one of minute 100, as a sub-agent's transcript can log it
      ompMessage('assistant', '2026-11-02T11:35:20.000Z', usage(1, 2, 30, 4, 0.25)),
      ompMessage('assistant', '2026-11-02T11:40:50.000Z', usage(10, 5, 100, 20, 0.5)),
    ];

    const { minutes } = readStats('omp', lines.join('\n'), NOW).detail;

    expect(minutes).toEqual([
      { m: minuteOf('2026-11-02T11:35:00.000Z'), cost: 0.25, tokens: 37, read: 30, write: 4, uncached: 1 },
      { m: minuteOf('2026-11-02T11:40:00.000Z'), cost: 1, tokens: 270, read: 200, write: 40, uncached: 20 },
    ]);
  });

  test('a Claude Code minute has tokens and no cost', () => {
    const lines = [
      claudeAssistant('2026-11-02T11:00:10.000Z', 'r1', claudeUsage(10, 5, 100, 20)),
      // the response r2 written again a minute later: it counts in the later minute alone
      claudeAssistant('2026-11-02T11:00:30.000Z', 'r2', claudeUsage(30, 2, 400, 50)),
      claudeAssistant('2026-11-02T11:01:05.000Z', 'r2', claudeUsage(30, 7, 400, 50)),
    ];

    const { minutes } = readStats('claude-code', { text: lines.join('\n'), sources: { wholeFile: true } }, NOW).detail;

    const first = minuteOf('2026-11-02T11:00:00.000Z');
    expect(minutes).toEqual([
      { m: first, cost: null, tokens: 135, read: 100, write: 20, uncached: 10 },
      { m: first + 1, cost: null, tokens: 487, read: 400, write: 50, uncached: 30 },
    ]);
    expect(minuteSums(minutes, first, first + 1)).toEqual({ m: first + 1, cost: null, tokens: 622, read: 500, write: 70, uncached: 40 });
  });

  test('opencode rows give their minutes', () => {
    const at = (iso: string) => Date.parse(iso);
    const messages = [
      opencodeRow('u1', 'user', null, null, null, { created: at('2026-11-02T11:00:00.000Z') }),
      // dated by `created`, though it completed in the next minute
      opencodeRow('a1', 'assistant', 10, 200, 30, { created: at('2026-11-02T11:00:50.000Z'), completed: at('2026-11-02T11:01:10.000Z'), cost: 0.2, total: 249 }),
      opencodeRow('a2', 'assistant', 20, 500, 40, { created: at('2026-11-02T11:02:00.000Z'), completed: at('2026-11-02T11:02:20.000Z'), cost: 0.3, total: 569 }),
      opencodeRow('a3', 'assistant', 1, 90, 0, { created: at('2026-11-02T11:02:40.000Z'), completed: at('2026-11-02T11:02:50.000Z'), cost: 0.1, total: 100 }),
    ];

    const { minutes } = readStats('opencode', { messages, compactions: null, tools: [] }, NOW).detail;

    const first = minuteOf('2026-11-02T11:00:00.000Z');
    expect(minutes).toEqual([
      { m: first, cost: 0.2, tokens: 249, read: 200, write: 30, uncached: 10 },
      { m: first + 2, cost: 0.3 + 0.1, tokens: 669, read: 590, write: 40, uncached: 21 },
    ]);
  });
});
