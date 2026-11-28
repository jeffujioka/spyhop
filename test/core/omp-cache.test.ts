import { describe, test } from 'node:test';
import { NA, readStats } from '../../src/core/providers/index.js';
import { MINUTE, NOW, ompMessage } from './helpers/entries.ts';
import { expect } from './helpers/expect.ts';

// One synthetic assistant message entry. `usage` and `extra` (message fields such as
// completedAt) are merged in as given.
const assistant = (usage, extra = {}) => ompMessage('assistant', '2026-11-02T11:00:00.000Z', usage, extra);

const tokens = (input, cacheRead, cacheWrite) => ({ input, cacheRead, cacheWrite });

describe('omp session: cache statistics', () => {
  test('hit rate', () => {
    // input 100, cacheRead 800, cacheWrite 100 summed over two messages
    const text = [assistant(tokens(40, 300, 60)), assistant(tokens(60, 500, 40))].join('\n');

    expect(readStats('omp', text, NOW).cacheHitRate).toBeCloseTo(0.8, 10);
  });

  test('per-turn hits and misses', () => {
    const text = [
      assistant(tokens(1, 500, 0)),
      assistant(tokens(1, 0, 500)),
      assistant(tokens(1, 800, 0)),
      assistant(tokens(1, 0, 20)),
      assistant(tokens(1, 900, 0)),
    ].join('\n');
    const stats = readStats('omp', text, NOW);

    expect(stats.cacheHits).toBe(3);
    expect(stats.cacheMisses).toBe(2);
  });

  test('no tokens is n/a', () => {
    const zero = assistant(tokens(0, 0, 0));
    const stats = readStats('omp', zero, NOW);

    expect(stats.cacheHitRate).toBe(NA);
    // with no usage at all no turn can be counted either
    const bare = readStats('omp', assistant(null), NOW);
    expect(bare.cacheHitRate).toBe(NA);
    expect(bare.cacheHits).toBe(NA);
    expect(bare.cacheMisses).toBe(NA);
  });
});

describe('omp session: cache expiry countdown', () => {
  const cached = { ...tokens(1, 100, 50), cttl: { ephemeral5m: 50 } };

  test('countdown', () => {
    // last assistant turn completed 2 minutes ago: 3 minutes left
    const text = assistant(cached, { completedAt: NOW - 2 * MINUTE });
    expect(readStats('omp', text, NOW).cacheLeftMs).toBe(3 * MINUTE);

    // without completedAt the turn's start plus its duration is the time
    const fallback = assistant(cached, { timestamp: NOW - 3 * MINUTE, duration: MINUTE });
    expect(readStats('omp', fallback, NOW).cacheLeftMs).toBe(3 * MINUTE);

    // the latest assistant turn counts
    const older = assistant(cached, { completedAt: NOW - 4 * MINUTE });
    const newer = assistant(cached, { completedAt: NOW - MINUTE });
    expect(readStats('omp', [older, newer].join('\n'), NOW).cacheLeftMs).toBe(4 * MINUTE);
  });

  test('expired is cold', () => {
    const text = assistant(cached, { completedAt: NOW - 6 * MINUTE });
    expect(readStats('omp', text, NOW).cacheLeftMs).toBe(0);
  });

  test('missing cttl is n/a', () => {
    const noCttl = assistant(tokens(1, 100, 0), { completedAt: NOW - 2 * MINUTE });
    expect(readStats('omp', noCttl, NOW).cacheLeftMs).toBe(NA);

    // a cttl class the provider does not know gives no lifetime
    const unknown = assistant(
      { ...tokens(1, 100, 50), cttl: { ephemeral2h: 50 } },
      { completedAt: NOW - 2 * MINUTE },
    );
    expect(readStats('omp', unknown, NOW).cacheLeftMs).toBe(NA);

    // a turn with a cttl but no time to count from
    expect(readStats('omp', assistant(cached), NOW).cacheLeftMs).toBe(NA);

    // the last assistant turn decides, not an earlier one that had a cttl
    const earlier = assistant(cached, { completedAt: NOW - 4 * MINUTE });
    expect(readStats('omp', [earlier, noCttl].join('\n'), NOW).cacheLeftMs).toBe(NA);
  });
});
