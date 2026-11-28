// What a call through GitHub Copilot (provider `github-copilot`) costs, as Copilot bills it: its
// tokens at the model's price in AI credits, at CREDIT_USD a credit. Runtime-neutral and pure.
//
// Prices: GitHub's published Copilot model prices, read on 2026-11-28 from
// https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
// (USD per million tokens there; AI credits per million tokens here, 1 credit = 0.01 USD). A model
// the page gives no cache write price (Kimi K3) writes to the cache at 0. The keys are the model
// ids omp (`model`) and opencode (`modelID`) log for `github-copilot`; a `-1m` id is the model
// with its 1 million token context window, priced as the model. The ids they log that the page
// does not price (gpt-5.5, claude-opus-5, claude-opus-4.6, gemini-3.1-pro-preview) are left out.

/**
 * AI credits per million tokens: those sent not cached (`input`), read from the cache
 * (`cachedInput`), written to it (`cacheWrite`) and output; `tiers`: the prices of a prompt over
 * `over` tokens (long context).
 * @typedef {{ input: number; cachedInput: number; cacheWrite: number; output: number }} Rates
 * @typedef {Rates & { tiers: ({ over: number } & Rates)[] }} Price
 */

import { isNumber } from './providers/shared.js';

export const CREDIT_USD = 0.01;

// The provider of the calls through GitHub Copilot, which the Copilot price table prices.
export const COPILOT = 'github-copilot';

const opus55 = { input: 400, cachedInput: 20, cacheWrite: 500, output: 2000, tiers: [] };
const sonnet55 = { input: 200, cachedInput: 10, cacheWrite: 250, output: 1000, tiers: [] };
const haiku55 = {
  input: 10,
  cachedInput: 1,
  cacheWrite: 12.5,
  output: 50,
  tiers: [{ over: 100_000, input: 50, cachedInput: 5, cacheWrite: 62.5, output: 250 }],
};

/** @type {Record<string, Price>} */
export const COPILOT_PRICES = {
  'claude-haiku-4.5': { input: 100, cachedInput: 10, cacheWrite: 125, output: 500, tiers: [] },
  'claude-haiku-5.5': haiku55,
  'claude-haiku-5.5-1m': haiku55,
  'claude-sonnet-4.6': { input: 300, cachedInput: 30, cacheWrite: 375, output: 1500, tiers: [] },
  'claude-sonnet-5': { input: 200, cachedInput: 20, cacheWrite: 250, output: 1000, tiers: [] },
  'claude-sonnet-5.5': sonnet55,
  'claude-sonnet-5.5-1m': sonnet55,
  'claude-opus-4.8': { input: 500, cachedInput: 50, cacheWrite: 625, output: 2500, tiers: [] },
  'claude-opus-5.5': opus55,
  'claude-opus-5.5-1m': opus55,
  'claude-fable-5': { input: 1000, cachedInput: 100, cacheWrite: 1250, output: 5000, tiers: [] },
  'claude-fable-5.1': { input: 1000, cachedInput: 25, cacheWrite: 1250, output: 5000, tiers: [] },
  'claude-fable-5.2': { input: 800, cachedInput: 20, cacheWrite: 1000, output: 4000, tiers: [] },
  'gpt-5.6-luna': {
    input: 20,
    cachedInput: 2,
    cacheWrite: 25,
    output: 120,
    tiers: [{ over: 200_000, input: 40, cachedInput: 4, cacheWrite: 50, output: 180 }],
  },
  'gpt-6-astra': {
    input: 1000,
    cachedInput: 100,
    cacheWrite: 1250,
    output: 5000,
    tiers: [{ over: 272_000, input: 2000, cachedInput: 200, cacheWrite: 2500, output: 7500 }],
  },
  'kimi-k3': { input: 300, cachedInput: 30, cacheWrite: 0, output: 1500, tiers: [] },
};

// The rates of `model` for a prompt of `prompt` tokens: its tier with the highest `over` below
// the prompt, else its base rates; null when the table does not hold the model.
function ratesOf(model, prompt) {
  const price = COPILOT_PRICES[model];
  if (!price) return null;
  const passed = price.tiers.filter((tier) => tier.over < prompt);
  return passed.length === 0 ? price : passed.reduce((top, tier) => (tier.over > top.over ? tier : top));
}

// The cost in USD of a Copilot call on `model` that sent `uncached` prompt tokens not cached,
// read `read` from the cache, wrote `write` to it and output `output`; null for a model the table
// does not hold.
export function copilotCost(model, { uncached, read, write, output }) {
  const rates = ratesOf(model, uncached + read + write);
  if (!rates) return null;
  const credits = uncached * rates.input + read * rates.cachedInput + write * rates.cacheWrite + output * rates.output;
  return (credits / 1_000_000) * CREDIT_USD;
}

// The cost in USD of a model call through `provider` on `model` that spent `tokens` (`{ uncached,
// read, write, output }`, each a count) and logged the cost `logged`: a Copilot call's from the
// Copilot price table (null for a model it does not hold; undefined, nothing to add, for a call
// that spent no token: one aborted, or that failed before the model answered), any other's as
// logged (null: none logged).
export function callCost(provider, model, tokens, logged) {
  if (provider !== COPILOT) return isNumber(logged) ? logged : null;
  if (!Object.values(tokens).some((count) => count > 0)) return undefined;
  return copilotCost(model, tokens);
}

// The cost in USD of the `write` tokens a Copilot call on `model` wrote to the cache, in a prompt
// of `prompt` tokens; null for a model the table does not hold.
export function copilotWriteCost(model, write, prompt) {
  const rates = ratesOf(model, prompt);
  if (!rates) return null;
  return ((write * rates.cacheWrite) / 1_000_000) * CREDIT_USD;
}
