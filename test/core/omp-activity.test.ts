import { describe, test } from 'node:test';
import { NA, readStats } from '../../src/core/providers/index.js';
import { ompMessage } from './helpers/entries.ts';
import { expect } from './helpers/expect.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const START = Date.parse('2026-11-02T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// One synthetic message entry of `role` at `at` ms (epoch).
const message = (role, at, usage) => ompMessage(role, iso(at), usage);

const user = (at) => message('user', at);
const assistant = (at, usage) => message('assistant', at, usage);

describe('omp session: burn rate, activity, latency and thinking', () => {
  test('burn rate', () => {
    // 30 minutes, cost 1.00 over two turns, 60,000 tokens over two turns
    const text = [
      user(START),
      assistant(START + 10 * MINUTE, { totalTokens: 20000, cost: { total: 0.4 } }),
      assistant(START + 30 * MINUTE, { totalTokens: 40000, cost: { total: 0.6 } }),
    ].join('\n');
    const stats = readStats('omp', text, START + 31 * MINUTE);

    expect(stats.burnCostPerHour).toBeCloseTo(2, 10);
    expect(stats.burnTokensPerMin).toBeCloseTo(2000, 10);
  });

  test('zero duration is n/a', () => {
    // a single message: duration 0
    const stats = readStats('omp', assistant(START, { totalTokens: 500, cost: { total: 0.2 } }), START);

    expect(stats.durationMs).toBe(0);
    expect(stats.burnCostPerHour).toBe(NA);
    expect(stats.burnTokensPerMin).toBe(NA);

    // a rate whose input is not logged is n/a, the other one stays
    const noCost = [user(START), assistant(START + MINUTE, { totalTokens: 600 })].join('\n');
    const partial = readStats('omp', noCost, START + MINUTE);
    expect(partial.burnCostPerHour).toBe(NA);
    expect(partial.burnTokensPerMin).toBe(600);
  });

  test('time since last activity', () => {
    const text = [user(START), assistant(START + 10 * SECOND)].join('\n');

    expect(readStats('omp', text, START + 10 * SECOND + 90 * SECOND).sinceActivityMs).toBe(90 * SECOND);
    expect(readStats('omp', '', START).sinceActivityMs).toBe(NA);
  });

  test('last turn latency', () => {
    // the last turn: a user message, then tool-using assistant messages; it ends 12 s after
    // the user message that began it, not after the earlier turn's
    const text = [
      user(START),
      assistant(START + 30 * SECOND),
      user(START + MINUTE),
      assistant(START + MINUTE + 5 * SECOND),
      message('toolResult', START + MINUTE + 6 * SECOND),
      assistant(START + MINUTE + 12 * SECOND),
    ].join('\n');

    expect(readStats('omp', text, START + 5 * MINUTE).latencyMs).toBe(12 * SECOND);

    // an assistant message with no user message before it has no turn start
    expect(readStats('omp', assistant(START), START).latencyMs).toBe(NA);
  });

  test('thinking and premium requests', () => {
    const level = (at, thinkingLevel) =>
      JSON.stringify({ type: 'thinking_level_change', id: 't', timestamp: iso(at), thinkingLevel });
    const text = [
      level(START, 'low'),
      user(START),
      assistant(START + SECOND, { premiumRequests: 3 }),
      level(START + 2 * SECOND, 'high'),
      assistant(START + 3 * SECOND, { premiumRequests: 4 }),
      assistant(START + 4 * SECOND),
    ].join('\n');
    const stats = readStats('omp', text, START + MINUTE);

    // the latest level change; the sum covers the messages that carry the field
    expect(stats.thinkingLevel).toBe('high');
    expect(stats.premiumRequests).toBe(7);

    // neither logged: n/a
    const bare = readStats('omp', [user(START), assistant(START + SECOND)].join('\n'), START + MINUTE);
    expect(bare.thinkingLevel).toBe(NA);
    expect(bare.premiumRequests).toBe(NA);
  });
});
