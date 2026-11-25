// The `expect` matchers the core tests were written with, on node:assert, so the tests ported
// from herdr-session-stats keep their assertions as written.
import assert from 'node:assert/strict';

// Whether `actual` holds every property of `expected`, recursively (arrays element by element).
function matches(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => matches(actual[i], item));
  }
  return Object.entries(expected).every(([key, value]) => matches((actual as Record<string, unknown>)[key], value));
}

export function expect(actual: unknown) {
  const number = Number(actual);
  // the strings and arrays a test asks `toContain` and `toHaveLength` of
  const list = actual as string | unknown[];
  return {
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
    toBeNull: () => assert.equal(actual, null),
    toBeUndefined: () => assert.equal(actual, undefined),
    toBeCloseTo: (expected: number, digits = 2) =>
      assert.ok(Math.abs(number - expected) < 10 ** -digits / 2, `${number} is not close to ${expected}`),
    toBeGreaterThan: (expected: number) => assert.ok(number > expected, `${number} > ${expected}`),
    toBeGreaterThanOrEqual: (expected: number) => assert.ok(number >= expected, `${number} >= ${expected}`),
    toBeLessThan: (expected: number) => assert.ok(number < expected, `${number} < ${expected}`),
    toBeLessThanOrEqual: (expected: number) => assert.ok(number <= expected, `${number} <= ${expected}`),
    toContain: (expected: string) => assert.ok(list.includes(expected), `${String(actual)} contains ${expected}`),
    toHaveLength: (expected: number) => assert.equal(list.length, expected),
    toMatch: (expected: RegExp) => assert.match(String(actual), expected),
    toMatchObject: (expected: object) => assert.ok(matches(actual, expected), `${JSON.stringify(actual)} matches ${JSON.stringify(expected)}`),
    not: {
      toBe: (expected: unknown) => assert.notEqual(actual, expected),
      toBeNull: () => assert.notEqual(actual, null),
      toContain: (expected: string) => assert.ok(!list.includes(expected), `${String(actual)} does not contain ${expected}`),
    },
  };
}
