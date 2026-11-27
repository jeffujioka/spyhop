// The contexts of the last model calls of a session, which the card's spark line draws: the
// bounded list `pushRecent` keeps, and the `detail.recent` each provider's `readStats` gives
// beside its stats, from the whole session only.
import { describe, test } from 'node:test';
import { readStats } from '../../src/core/providers/index.js';
import { SPARK_CALLS, pushRecent } from '../../src/core/series.js';
import { NOW, claudeAssistant, claudeUsage, ompMessage } from './helpers/entries.ts';
import { expect } from './helpers/expect.ts';

// 12 omp assistant messages whose prompts held 1000, 2000, … 12000 tokens, as jsonl lines.
const ompCalls = Array.from({ length: 12 }, (_, i) =>
  ompMessage('assistant', `2026-11-02T11:${String(i).padStart(2, '0')}:00.000Z`, null, { contextSnapshot: { promptTokens: (i + 1) * 1000 } }),
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

    expect(whole.detail).toEqual({ recent: Array.from({ length: 12 }, (_, i) => (i + 1) * 1000) });
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
    expect(stats.detail).toEqual({ recent: [130, 480] });
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
