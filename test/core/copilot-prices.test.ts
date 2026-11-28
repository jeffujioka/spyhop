// How src/core/copilot-prices.js prices a Copilot call from its price table, in USD.
import { test } from 'node:test';
import { copilotCost, copilotWriteCost } from '../../src/core/copilot-prices.js';
import { withCopilotPrices } from '../helpers/prices.ts';
import { expect } from './helpers/expect.ts';

const MODEL = 'claude-opus-5.5';

// `claude-opus-5.5` at 500/50/625/2500 credits per million tokens, and at 1000/100/1250/3750 for a
// prompt over 200,000 tokens
function opusPrices() {
  withCopilotPrices({
    [MODEL]: {
      input: 500,
      cachedInput: 50,
      cacheWrite: 625,
      output: 2500,
      tiers: [{ over: 200_000, input: 1000, cachedInput: 100, cacheWrite: 1250, output: 3750 }],
    },
  });
}

test('a call is priced from the table', () => {
  opusPrices();
  expect(copilotCost(MODEL, { uncached: 10_000, read: 100_000, write: 16_000, output: 2_000 })).toBeCloseTo(0.25, 9);
});

test("a prompt past a tier's threshold prices the whole call at the tier", () => {
  opusPrices();
  expect(copilotCost(MODEL, { uncached: 10_000, read: 240_000, write: 0, output: 4_000 })).toBeCloseTo(0.49, 9);
});

test('a prompt at the threshold keeps the base prices', () => {
  opusPrices();
  // 200,000 prompt tokens: 0.10 at the base prices, 0.20 at the tier's
  expect(copilotCost(MODEL, { uncached: 0, read: 200_000, write: 0, output: 0 })).toBeCloseTo(0.1, 9);
});

test('a model missing from the table costs null', () => {
  opusPrices();
  expect(copilotCost('kimi-k3', { uncached: 10_000, read: 0, write: 0, output: 1_000 })).toBeNull();
  expect(copilotWriteCost('kimi-k3', 10_000, 10_000)).toBeNull();
});

test('a cache write is priced at its cache write price', () => {
  opusPrices();
  expect(copilotWriteCost(MODEL, 160_000, 160_000)).toBeCloseTo(1.0, 9);
});
