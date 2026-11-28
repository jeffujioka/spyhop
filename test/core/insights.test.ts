import { beforeEach, describe, test } from 'node:test';
import { rangeDays } from '../../src/core/days.js';
import { takeLines } from '../../src/core/insights.js';
import { ompProvider } from '../../src/core/providers/omp.js';
import { setEnv } from '../helpers/env.ts';
import { ompMessage } from './helpers/entries.ts';
import { expect } from './helpers/expect.ts';

// One omp model call ending at the ISO `timestamp`, of `cost` USD (none logged when null).
const call = (timestamp: string, cost: number | null = 1, extra: object = {}) =>
  JSON.parse(ompMessage('assistant', timestamp, { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, totalTokens: 100, ...(cost !== null && { cost: { total: cost } }) }, extra));

const fold = (entries: object[]) => ompProvider.fold(undefined, entries, { insights: true });

describe('insights: day buckets of model calls', () => {
  beforeEach(() => setEnv('TZ', 'Europe/Berlin'));

  test('a call lands on the local day of its end', () => {
    const session = { type: 'session', timestamp: '2026-11-27T20:00:00.000Z', cwd: '/home/u/proj' };
    const state = fold([session, call('2026-11-27T23:30:00.000Z')]);

    expect(state.cwd).toBe('/home/u/proj');
    expect(takeLines(state.insights)).toEqual([
      {
        day: '2026-11-28',
        model: 'p/m',
        figures: { calls: 1, tokens: 100, uncached: 10, read: 20, write: 30, output: 40, cost: 1, costNa: 0 },
      },
    ]);
  });

  test('calls on both sides of midnight land on their own days', () => {
    // 23:59:30 and 00:00:30 in Berlin (UTC+1 in November)
    const state = fold([call('2026-11-27T22:59:30.000Z'), call('2026-11-27T23:00:30.000Z')]);

    expect(takeLines(state.insights).map((line) => line.day)).toEqual(['2026-11-27', '2026-11-28']);
  });

  test('a model is named with its provider', () => {
    const named = fold([call('2026-11-27T12:00:00.000Z', 1, { provider: 'github-copilot', model: 'claude-opus-5.5' })]);
    expect(takeLines(named.insights)[0].model).toBe('github-copilot/claude-opus-5.5');

    // without a provider the model stands alone
    const bare = fold([call('2026-11-27T12:00:00.000Z', 1, { provider: undefined, model: 'claude-opus-5.5' })]);
    expect(takeLines(bare.insights)[0].model).toBe('claude-opus-5.5');
  });

  test('a call that logs no model is filed under no model', () => {
    const state = fold([
      call('2026-11-27T12:00:00.000Z', 1, { provider: 'p', model: undefined }),
      call('2026-11-27T12:01:00.000Z', 1, { provider: undefined, model: undefined }),
      call('2026-11-27T12:02:00.000Z', 2),
    ]);

    expect(takeLines(state.insights).map((line) => [line.model, line.figures.cost])).toEqual([['p/m', 2]]);
  });

  test('a call of no logged cost counts in costNa', () => {
    const state = fold([call('2026-11-27T12:00:00.000Z', 2), call('2026-11-27T12:01:00.000Z', null)]);
    const [line] = takeLines(state.insights);

    expect(line.figures.calls).toBe(2);
    expect(line.figures.cost).toBe(2);
    expect(line.figures.costNa).toBe(1);
  });

  test('lines are taken once', () => {
    const state = fold([call('2026-11-27T12:00:00.000Z')]);

    expect(takeLines(state.insights)).toHaveLength(1);
    expect(takeLines(state.insights)).toEqual([]);
  });

  test('a fold without insights keeps none', () => {
    expect(ompProvider.fold(undefined, [call('2026-11-27T12:00:00.000Z')]).insights).toBe(null);
  });

  test('ranges end today', () => {
    // 2026-11-28 15:00 in Berlin
    const now = Date.parse('2026-11-28T14:00:00.000Z');

    const week = rangeDays('week', now);
    expect([week.from, week.to, week.by]).toEqual(['2026-11-22', '2026-11-28', 'day']);
    expect(week.points).toHaveLength(7);

    const month = rangeDays('month', now);
    expect([month.from, month.to]).toEqual(['2026-10-30', '2026-11-28']);
    expect(month.points).toHaveLength(30);

    const year = rangeDays('year', now);
    expect([year.from, year.to, year.by]).toEqual(['2025-12', '2026-11', 'month']);
    expect(year.points).toHaveLength(12);

    const day = rangeDays('day', now);
    expect([day.from, day.to, day.by]).toEqual(['2026-11-28', '2026-11-28', null]);
  });
});
