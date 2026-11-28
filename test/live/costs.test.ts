// What an omp session costs on its session screen: its side calls (omp's `model_usage` entries)
// counted in its cost but not as model calls, and its Copilot calls priced from the Copilot price
// table (src/core/copilot-prices.js), which the tests set (test/helpers/prices.ts). Drawn from the
// real worker's session answer over omp session files under a temporary home (`sessionOf`,
// test/helpers/live.ts), and read through the markup's conventions (test/helpers/markup.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOW } from '../helpers/agent-cards.ts';
import { FIX, folderOf, ompSession, sessionOf, type OmpCall } from '../helpers/live.ts';
import { figure, parts, text } from '../helpers/markup.ts';
import { withCopilotPrices } from '../helpers/prices.ts';

const MINUTE = 60_000;

// The session screen of FIX's omp session, whose model calls are `calls`.
async function screenOf(calls: OmpCall[]) {
  const { html } = await sessionOf([FIX], { prepare: (home) => ompSession(home, folderOf(home, FIX), { title: 'Fix the login bug', calls }) });
  return html;
}

// The rows of the Models section of `html`, each as the text it shows.
const models = (html: string) => parts(parts(html, 'data-part', 'models')[0], 'class', 'row item').map(text);

// The Copilot price table of the spec: `claude-opus-5.5` alone.
const OPUS_PRICES = { 'claude-opus-5.5': { input: 500, cachedInput: 50, cacheWrite: 625, output: 2500, tiers: [] } };

// The spec's Copilot call on `claude-opus-5.5`, which the table prices at 0.25 USD and omp logged
// at 0.90 USD.
const copilotCall: OmpCall = { at: NOW - 2 * MINUTE, provider: 'github-copilot', model: 'claude-opus-5.5', uncached: 10_000, read: 100_000, write: 16_000, output: 2_000, cost: 0.9 };

test('Session cost with side calls', async () => {
  const opus = { provider: 'anthropic', model: 'claude-opus-5.5', output: 100 };
  const haiku = { provider: 'anthropic', model: 'claude-haiku-5.5', output: 100 };
  const html = await screenOf([
    { ...opus, at: NOW - 5 * MINUTE, cost: 0.5 },
    { ...haiku, at: NOW - 5 * MINUTE + 1, side: 'title-fork', cost: 0.04 },
    { ...opus, at: NOW - 4 * MINUTE, cost: 0.75 },
    { ...opus, at: NOW - 3 * MINUTE, cost: 0.75 },
    { ...haiku, at: NOW - 2 * MINUTE, side: 'recap', cost: 0.02 },
  ]);

  assert.equal(figure(html, 'cost'), '$2.06');
  assert.equal(figure(html, 'calls'), '3');
  assert.deepEqual(models(html), ['anthropic/claude-opus-5.5 · main agent · $2.00', 'anthropic/claude-haiku-5.5 · side calls · $0.06']);
});

test('Copilot call priced from the table', async () => {
  withCopilotPrices(OPUS_PRICES);

  const html = await screenOf([copilotCall]);

  assert.equal(figure(html, 'cost'), '$0.25');
});

test('Model missing from the table', async () => {
  withCopilotPrices(OPUS_PRICES);

  const html = await screenOf([copilotCall, { at: NOW - MINUTE, provider: 'github-copilot', model: 'kimi-k3', uncached: 1_000, output: 100, cost: 0.01 }]);

  assert.equal(figure(html, 'cost'), 'n/a');
  assert.deepEqual(models(html), ['github-copilot/claude-opus-5.5 · main agent · $0.25', 'github-copilot/kimi-k3 · main agent · n/a']);
});

test('Other provider keeps its logged cost', async () => {
  withCopilotPrices(OPUS_PRICES);

  const html = await screenOf([{ ...copilotCall, provider: 'anthropic', cost: 0.4 }]);

  assert.equal(figure(html, 'cost'), '$0.40');
});

// A guard of the aborted call, no scenario of the spec: omp logs an all-zero usage for a call it
// aborted, which sent nothing, so it costs nothing even on a model the table does not hold.
test('a Copilot call without usage costs nothing', async () => {
  withCopilotPrices(OPUS_PRICES);

  const html = await screenOf([copilotCall, { at: NOW - MINUTE, provider: 'github-copilot', model: 'kimi-k3', uncached: 0, read: 0, write: 0, output: 0, cost: 0 }]);

  assert.equal(figure(html, 'cost'), '$0.25');
  assert.equal(figure(html, 'calls'), '1');
});
