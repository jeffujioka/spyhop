// The fleet screen's burn rate card and each card's burn rate: the cost the shown sessions and
// their sub-agents logged in the last 10 minutes, as cost per hour, the chart of the last 60
// minutes stacked by session, the card's other figures and which harnesses count, drawn from the
// real worker's answer over omp, Claude Code and opencode session files under a temporary home
// (test/helpers/live.ts), and read through the markup's conventions (test/helpers/markup.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINUTE } from '../core/helpers/entries.ts';
import { NOW, opencodeCalls, workspace } from '../helpers/agent-cards.ts';
import { burnOf, claudeSession, claudeSubAgent, spent } from '../helpers/live.ts';
import { attr, figure, parts, text } from '../helpers/markup.ts';
import type { HostWorkspace } from '../helpers/orca-host.ts';

// This computer's workspace `web`/`main`, with one working Claude Code agent.
const CLAUDE: HostWorkspace = { project: 'web', name: 'main', agents: ['working'], harness: 'claude' };

// The card titled `title` of the fleet screen `html`.
const cardOf = (html: string, title: string) => parts(html, 'data-part', 'card').find((card) => text(card).startsWith(title))!;

test('Burn rate of two sessions', async () => {
  const { burn } = await burnOf([
    { title: 'a', calls: [spent(3, NOW - 30 * MINUTE), spent(1, NOW - 5 * MINUTE)] },
    { title: 'b', calls: [spent(0.3, NOW - 4 * MINUTE)], subAgents: [{ name: 'Impl1', calls: [spent(0.2, NOW - 3 * MINUTE)] }] },
  ]);

  assert.equal(figure(burn, 'perHour'), '$9.00/h');
  assert.match(text(burn), /all sessions \$4\.50/);
  assert.doesNotMatch(text(burn), /today|per day|\/day/i);
});

test('Cost older than 10 minutes', async () => {
  const { burn } = await burnOf([{ title: 'a', calls: [spent(2, NOW - 11 * MINUTE)] }]);

  assert.equal(figure(burn, 'perHour'), '$0.00/h');
  assert.equal(figure(burn, 'total'), '$2.00');
});

test('Chart ends at the burn rate', async () => {
  const { answer, burn } = await burnOf([{ title: 'a', calls: [spent(2, NOW - 32 * MINUTE), spent(1, NOW - 5 * MINUTE)] }]);

  const { layers } = answer.burn;
  assert.notEqual(layers, 'n/a');
  if (layers === 'n/a') return;
  assert.deepEqual(
    layers.map(({ name }) => name),
    ['a'],
  );
  const [{ values }] = layers;
  assert.equal(values.length, 60);
  // oldest first: the newest is the minute of now, 30 minutes ago is the 30th from the end
  assert.ok(Math.abs(values[59] - 6) < 1e-9);
  assert.ok(Math.abs(values[59 - 30] - 12) < 1e-9);
  assert.equal(values[59 - 15], 0);
  assert.equal(figure(burn, 'perHour'), '$6.00/h');
  const [chart] = parts(burn, 'data-chart', 'burn');
  assert.ok(chart);
  assert.doesNotMatch(chart, /<text/);
  assert.equal(attr(parts(chart, 'data-layer', 'a')[0], 'data-last'), '6');
  assert.deepEqual(parts(chart, 'data-layer', 'others'), []);
});

test('Burn rate beside a call that logged no cost', async () => {
  // the call of 30 minutes ago is in the chart's minutes, not in the burn rate's
  const { answer, burn, html } = await burnOf([{ title: 'a', calls: [{ at: NOW - 30 * MINUTE, output: 100 }, spent(1, NOW - 5 * MINUTE)] }]);

  assert.equal(figure(burn, 'perHour'), '$6.00/h');
  assert.equal(figure(cardOf(html, 'a'), 'burnPerHour'), '$6.00/h');
  assert.equal(answer.burn.layers, 'n/a');
  assert.deepEqual(parts(burn, 'data-chart', 'burn'), []);
});

test('Three sessions named, the rest as others', async () => {
  const costs = { a: 0.5, b: 0.4, c: 0.3, d: 0.2, e: 0.1 };
  const { burn } = await burnOf(Object.entries(costs).map(([title, usd]) => ({ title, calls: [spent(usd, NOW - 5 * MINUTE)] })));

  const [chart] = parts(burn, 'data-chart', 'burn');
  const last = (layer: string) => attr(parts(chart, 'data-layer', layer)[0] ?? '', 'data-last');
  assert.deepEqual(
    parts(chart, 'data-layer').map((layer) => attr(layer, 'data-layer')),
    ['a', 'b', 'c', 'others'],
  );
  assert.equal(last('a'), '3');
  assert.equal(last('b'), '2.4');
  assert.equal(last('c'), '1.8');
  assert.equal(last('others'), '1.8');
  assert.deepEqual(parts(chart, 'data-layer', 'd'), []);
  assert.deepEqual(parts(chart, 'data-layer', 'e'), []);
});

test('Tokens per minute', async () => {
  const { burn } = await burnOf([
    {
      title: 'a',
      calls: [
        { at: NOW - 30 * MINUTE, uncached: 1_000_000 },
        { at: NOW - 5 * MINUTE, uncached: 40_000 },
      ],
      subAgents: [{ name: 'Impl1', calls: [{ at: NOW - 3 * MINUTE, uncached: 10_000 }] }],
    },
  ]);

  assert.match(text(burn), /\b5k tokens\/min/);
});

test('Cache hit rate over the last 60 minutes', async () => {
  const { burn } = await burnOf([
    {
      title: 'a',
      calls: [
        { at: NOW - 65 * MINUTE, uncached: 500_000 },
        { at: NOW - 30 * MINUTE, read: 900_000, write: 60_000, uncached: 40_000 },
      ],
    },
  ]);

  assert.match(text(burn), /cache 90%/);
});

test('Sub-agents that run now', async () => {
  const call = spent(0.1, NOW - 20 * MINUTE);
  const { burn } = await burnOf([
    {
      title: 'a',
      calls: [call],
      subAgents: [
        { name: 'Impl1', running: true, calls: [call] },
        { name: 'Impl2', running: true, calls: [call] },
        { name: 'Rev1', calls: [call] },
      ],
    },
    { title: 'b', calls: [call], subAgents: [{ name: 'Impl1', calls: [call] }] },
  ]);

  assert.match(text(burn), /\b2 sub-agents running/);
});

test('Claude Code session left out', async () => {
  const { burn, html } = await burnOf([{ title: 'a', calls: [spent(1, NOW - 5 * MINUTE)] }], {
    others: [CLAUDE],
    prepare: (home) => {
      claudeSession(home, workspace(home, 'web-main'), { calls: [{ at: NOW - 4 * MINUTE, uncached: 1000 }], cost: 5 });
      return [];
    },
  });

  assert.equal(figure(burn, 'perHour'), '$6.00/h');
  assert.match(text(burn), /leaves out 1 session\b/);
  assert.match(text(burn), /all sessions \$6\.00/);
  assert.equal(figure(cardOf(html, 'web-main'), 'burnPerHour'), 'n/a');
});

test('opencode session counts', async () => {
  const { burn } = await burnOf([], {
    others: [{ project: 'web', name: 'main', agents: ['working'], harness: 'opencode' }],
    prepare: (home) => {
      // five calls of 0.10 USD each, one a minute, the last a minute ago
      opencodeCalls(home, workspace(home, 'web-main'), { provider: 'github-copilot', model: 'claude-haiku-5.5', contexts: [1000, 1000, 1000, 1000, 1000] });
      return [];
    },
  });

  assert.equal(figure(burn, 'perHour'), '$3.00/h');
  assert.doesNotMatch(text(burn), /leaves out/);
});

test('Sums while sub-agents are read', async () => {
  const { burn } = await burnOf(
    [
      { title: 'a', calls: [spent(1, NOW - 5 * MINUTE)] },
      {
        title: 'b',
        calls: [spent(0.5, NOW - 5 * MINUTE)],
        subAgents: ['Impl1', 'Impl2', 'Impl3'].map((name) => ({ name, calls: [spent(0.1, NOW - 4 * MINUTE)] })),
      },
    ],
    { unread: [2] },
  );

  assert.match(text(burn), /all sessions n\/a/);
  assert.equal(figure(burn, 'perHour'), 'n/a');
  assert.equal(figure(burn, 'running'), 'n/a');
  assert.equal(figure(burn, 'tokensPerMin'), 'n/a');
  assert.equal(figure(burn, 'cacheHitRate'), 'n/a');
});

test('Session whose cost cannot be read', async () => {
  const { burn } = await burnOf([{ title: 'a', calls: [spent(1.5, NOW - 5 * MINUTE)] }], {
    others: [CLAUDE],
    prepare: (home) => {
      claudeSession(home, workspace(home, 'web-main'), { calls: [{ at: NOW - 4 * MINUTE, uncached: 1000 }] });
      return [];
    },
  });

  assert.match(text(burn), /all sessions n\/a/);
  assert.equal(figure(burn, 'perHour'), '$9.00/h');
});

test('Agent without a session', async () => {
  const { burn } = await burnOf([{ title: 'a', calls: [spent(1.5)] }], {
    others: [{ project: 'cli', name: 'main', agents: ['working'], harness: 'codex', title: 'Port the parser' }],
  });

  assert.match(text(burn), /all sessions \$1\.50/);
});

test('Burn rate of one session', async () => {
  const { html } = await burnOf([{ title: 'a', calls: [spent(0.5, NOW - 5 * MINUTE)], subAgents: [{ name: 'Impl1', calls: [spent(0.25, NOW - 3 * MINUTE)] }] }]);

  assert.equal(figure(cardOf(html, 'a'), 'burnPerHour'), '$4.50/h');
});

test('Card of a Claude Code session whose sub-agents are being read', async () => {
  const { burn, html } = await burnOf([{ title: 'a', calls: [spent(1, NOW - 5 * MINUTE)] }], {
    others: [CLAUDE],
    unread: [1],
    prepare: (home) => {
      const path = workspace(home, 'web-main');
      claudeSession(home, path, { calls: [{ at: NOW - 30 * MINUTE, uncached: 1000 }], cost: 39.33 });
      return [
        claudeSubAgent(home, path, 'a1', { calls: [{ at: NOW - 20 * MINUTE, uncached: 500 }], model: 'haiku' }),
        claudeSubAgent(home, path, 'a2', { calls: [{ at: NOW - 10 * MINUTE, uncached: 500 }], model: 'haiku' }),
      ];
    },
  });

  const card = cardOf(html, 'web-main');
  assert.match(text(card), /reading 1 of 2 sub-agents/);
  assert.equal(figure(card, 'cost'), '$39.33');
  assert.equal(figure(card, 'burnPerHour'), 'n/a');
  // a Claude Code session counts in no burn rate, so its reading leaves the rate alone
  assert.equal(figure(burn, 'perHour'), '$6.00/h');
});
