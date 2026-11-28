import { beforeEach, describe, test } from 'node:test';
import { midnightBefore, rangeDays } from '../../src/core/days.js';
import { LINE_FIGURES, takeLines } from '../../src/core/insights.js';
import { ompProvider } from '../../src/core/providers/omp.js';
import { setEnv } from '../helpers/env.ts';
import { ompMessage } from './helpers/entries.ts';
import { expect } from './helpers/expect.ts';
import { withCopilotPrices } from '../helpers/prices.ts';

// One omp model call ending at the ISO `timestamp`, of `cost` USD (none logged when null).
const call = (timestamp: string, cost: number | null = 1, extra: object = {}) =>
  JSON.parse(ompMessage('assistant', timestamp, { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, totalTokens: 100, ...(cost !== null && { cost: { total: cost } }) }, extra));

// The figures of a daily line: each LINE_FIGURES name 0, but those of `some`.
const figuresOf = (some: Record<string, number>) => ({ ...Object.fromEntries(LINE_FIGURES.map((name) => [name, 0])), ...some });

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
        figures: figuresOf({ calls: 1, tokens: 100, uncached: 10, read: 20, write: 30, output: 40, cost: 1 }),
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

  test('a side call adds its cost and tokens but no model call, and a Copilot call its cost', () => {
    withCopilotPrices({ 'claude-opus-5.5': { input: 500, cachedInput: 50, cacheWrite: 625, output: 2500, tiers: [] } });
    const side = {
      type: 'model_usage',
      timestamp: '2026-11-27T12:01:00.000Z',
      purpose: 'recap',
      provider: 'p',
      model: 'm',
      usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, totalTokens: 10, cost: { total: 0.5 } },
    };
    const copilot = call('2026-11-27T12:02:00.000Z', 9, { provider: 'github-copilot', model: 'claude-opus-5.5' });
    const state = fold([call('2026-11-27T12:00:00.000Z', 2), side, copilot]);
    const [line, copilotLine] = takeLines(state.insights);

    expect(line.figures).toEqual(figuresOf({ calls: 1, tokens: 110, uncached: 10, read: 20, write: 30, output: 40, cost: 2.5, sideCost: 0.5, sideTokens: 10 }));
    // 10 x 500 + 20 x 50 + 30 x 625 + 40 x 2,500 credits per million, at 0.01 USD a credit
    expect(copilotLine.figures.cost).toBeCloseTo(0.0012475, 9);
    expect(copilotLine.figures.copilotCost).toBe(copilotLine.figures.cost);
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

  test('the midnight days before today', () => {
    // 2026-11-28 15:00 in Berlin, and midnight there on 18 November
    const now = Date.parse('2026-11-28T14:00:00.000Z');

    expect(midnightBefore(now, 10)).toBe(Date.parse('2026-11-17T23:00:00.000Z'));
  });
});
