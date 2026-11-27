import { describe, test } from 'node:test';
import { NA, STAT_FIELDS, readStats, registerProvider } from '../../src/core/providers/index.js';
import { expect } from './helpers/expect.ts';

describe('provider interface', () => {
  test('unknown harness returns n/a for every figure', () => {
    const stats = readStats('no-such-harness', 'whatever input', Date.now());

    expect(stats.harness).toBe('no-such-harness');
    expect(STAT_FIELDS.length).toBeGreaterThan(0);
    for (const field of STAT_FIELDS) {
      expect(stats[field]).toBe(NA);
    }
    expect(stats.detail).toBeNull();
    expect(Object.keys(stats).sort()).toEqual(['harness', 'detail', ...STAT_FIELDS].sort());
  });

  test('registered fake provider is used', () => {
    const calls = [];
    registerProvider('fake-harness', {
      readStats(input, now) {
        calls.push({ input, now });
        return { model: 'fake-model', totalTokens: 42 };
      },
    });

    const stats = readStats('fake-harness', 'fake input', 1234);

    expect(calls).toEqual([{ input: 'fake input', now: 1234 }]);
    expect(stats.harness).toBe('fake-harness');
    expect(stats.model).toBe('fake-model');
    expect(stats.totalTokens).toBe(42);
    // Every figure the provider did not return reads n/a.
    for (const field of STAT_FIELDS.filter((f) => f !== 'model' && f !== 'totalTokens')) {
      expect(stats[field]).toBe(NA);
    }
  });
});
