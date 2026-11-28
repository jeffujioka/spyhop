// What an omp, an opencode or a Claude Code session costs on its session screen: omp's side calls
// (its `model_usage` entries) counted in its cost but not as model calls, the Copilot calls of omp
// or opencode priced from the Copilot price table (src/core/copilot-prices.js), which the tests set
// (test/helpers/prices.ts), and Claude Code's cost by model from its newest `cost-state`. Drawn
// from the real worker's session answer over omp or Claude Code session files or opencode's
// database under a temporary home (`sessionOf`, test/helpers/live.ts), and read through the
// markup's conventions (test/helpers/markup.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOW, opencodeSession, type OpencodeCall, workspace } from '../helpers/agent-cards.ts';
import { claudeSession, claudeSubAgent, FIX, folderOf, ompSession, sessionOf, type OmpCall } from '../helpers/live.ts';
import { figure, parts, text, textOutsideFigures } from '../helpers/markup.ts';
import { withCopilotPrices } from '../helpers/prices.ts';

const MINUTE = 60_000;

// The session answer and the session screen of FIX's omp session, whose model calls are `calls`.
const screenOf = (calls: OmpCall[]) => sessionOf([FIX], { prepare: (home) => ompSession(home, folderOf(home, FIX), { title: 'Fix the login bug', calls }) });

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
  const { html, answer } = await screenOf([
    { ...opus, at: NOW - 5 * MINUTE, cost: 0.5 },
    { ...haiku, at: NOW - 5 * MINUTE + 1, side: 'title-fork', cost: 0.04 },
    { ...opus, at: NOW - 4 * MINUTE, cost: 0.75 },
    { ...opus, at: NOW - 3 * MINUTE, cost: 0.75 },
    { ...haiku, at: NOW - 2 * MINUTE, side: 'recap', cost: 0.02 },
  ]);

  assert.equal(figure(html, 'cost'), '$2.06');
  assert.equal(figure(html, 'calls'), '3');
  assert.deepEqual(models(html), ['anthropic/claude-opus-5.5 · main agent · $2.00', 'anthropic/claude-haiku-5.5 · side calls · $0.06']);
  // the cost chart's own layer ends at the whole cost, side calls included
  const own = answer.session!.cost!.own;
  assert.ok(own !== 'n/a');
  assert.equal(own.at(-1)!.v.toFixed(2), '2.06');
  assert.equal(figure(html, 'noCall'), undefined);
});

test('Copilot call priced from the table', async () => {
  withCopilotPrices(OPUS_PRICES);

  const { html } = await screenOf([copilotCall]);

  assert.equal(figure(html, 'cost'), '$0.25');
});

test('Model missing from the table', async () => {
  withCopilotPrices(OPUS_PRICES);

  const { html } = await screenOf([copilotCall, { at: NOW - MINUTE, provider: 'github-copilot', model: 'kimi-k3', uncached: 1_000, output: 100, cost: 0.01 }]);

  assert.equal(figure(html, 'cost'), 'n/a');
  assert.deepEqual(models(html), ['github-copilot/claude-opus-5.5 · main agent · $0.25', 'github-copilot/kimi-k3 · main agent · n/a']);
});

test('Other provider keeps its logged cost', async () => {
  withCopilotPrices(OPUS_PRICES);

  const { html } = await screenOf([{ ...copilotCall, provider: 'anthropic', cost: 0.4 }]);

  assert.equal(figure(html, 'cost'), '$0.40');
});

// A guard of the aborted call, no scenario of the spec: omp logs an all-zero usage for a call it
// aborted, which sent nothing, so it costs nothing even on a model the table does not hold.
test('a Copilot call without usage costs nothing', async () => {
  withCopilotPrices(OPUS_PRICES);

  const { html } = await screenOf([copilotCall, { at: NOW - MINUTE, provider: 'github-copilot', model: 'kimi-k3', uncached: 0, read: 0, write: 0, output: 0, cost: 0 }]);

  assert.equal(figure(html, 'cost'), '$0.25');
  assert.equal(figure(html, 'calls'), '1');
});

// The session answer and the session screen of a working opencode agent of the workspace
// `web`/`main`, whose session logs `calls` of `github-copilot`'s `claude-opus-5.5` and opencode's
// own total of `cost` USD.
const opencodeScreenOf = (calls: OpencodeCall[], cost: number) =>
  sessionOf([{ project: 'web', name: 'main', agents: ['working'], harness: 'opencode' }], {
    prepare: (home) => opencodeSession(home, workspace(home, 'web-main'), { provider: 'github-copilot', model: 'claude-opus-5.5', calls, cost }),
  });

test('Long-context tier', async () => {
  withCopilotPrices({
    'claude-opus-5.5': { ...OPUS_PRICES['claude-opus-5.5'], tiers: [{ over: 200_000, input: 1000, cachedInput: 100, cacheWrite: 1250, output: 3750 }] },
  });

  const { html } = await opencodeScreenOf([{ uncached: 10_000, read: 240_000, write: 0, output: 4_000 }], 0.1);

  assert.equal(figure(html, 'cost'), '$0.49');
  assert.deepEqual(models(html), ['github-copilot/claude-opus-5.5 · main agent · $0.49']);
});

test('an opencode session with a Copilot call costs the sum of its calls', async () => {
  withCopilotPrices(OPUS_PRICES);

  const { html } = await opencodeScreenOf([{ uncached: 10_000, read: 100_000, write: 16_000, output: 2_000 }], 3);

  assert.equal(figure(html, 'cost'), '$0.25');
});

test('Models section of a Claude Code session', async () => {
  const { html } = await sessionOf([{ project: 'web', name: 'main', agents: ['working'], harness: 'claude' }], {
    prepare: (home) => {
      const path = workspace(home, 'web-main');
      claudeSession(home, path, {
        calls: [{ at: NOW - 2 * MINUTE, uncached: 500_000 }],
        model: 'claude-opus-5-5[1m]',
        costStates: [{ at: NOW - MINUTE, models: { 'claude-sonnet-5': 0.77, 'claude-haiku-4-5-20251001': 0.21, 'claude-opus-5-5[1m]': 5.24 } }],
      });
      claudeSubAgent(home, path, 'a1', { calls: [{ at: NOW - MINUTE, uncached: 74_880 }], model: 'claude-sonnet-5' });
    },
  });

  assert.deepEqual(models(html), ['claude-opus-5-5[1m] · $5.24', 'claude-sonnet-5 · $0.77', 'claude-haiku-4-5-20251001 · $0.21']);
  // each model's name is text, in the text font, and its cost a figure
  assert.equal(textOutsideFigures(parts(html, 'data-part', 'models')[0]), 'Models by cost claude-opus-5-5[1m] · claude-sonnet-5 · claude-haiku-4-5-20251001 ·');
  const [bar] = parts(parts(html, 'data-part', 'subagents')[0], 'data-agent');
  assert.equal(text(parts(bar, 'class', 'row label')[0]).split(' · ').at(-1), 'n/a');
});

// A guard of the carry-over, no scenario of the spec: a newer `cost-state` without `modelUsage`
// keeps the cost by model of the one before it, as n/a is only for a session none of whose
// `cost-state` entries holds one.
test('a cost-state without modelUsage keeps the cost by model before it', async () => {
  const { html } = await sessionOf([{ project: 'web', name: 'main', agents: ['working'], harness: 'claude' }], {
    prepare: (home) =>
      claudeSession(home, workspace(home, 'web-main'), {
        calls: [{ at: NOW - 3 * MINUTE, uncached: 1000 }],
        costStates: [
          { at: NOW - 2 * MINUTE, models: { 'claude-opus-4-6': 1.25 } },
          { at: NOW - MINUTE, models: null },
        ],
      }),
  });

  assert.deepEqual(models(html), ['claude-opus-4-6 · $1.25']);
});
