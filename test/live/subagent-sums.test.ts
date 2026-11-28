// A session's cost, tokens and models with its sub-agents': on the fleet screen's card and on the
// session screen, drawn from the real worker's answers over omp and Claude Code session files and
// their sub-agents' transcripts under a temporary home (test/helpers/live.ts), and read through
// the markup's conventions (test/helpers/markup.ts). The sums are shown only once every
// sub-agent transcript is read; until then the session's own figure, with how many are read.
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { test } from 'node:test';
import { costAt } from '../../src/live/charts.ts';
import { fleetScreen } from '../../src/live/fleet.ts';
import { NOW, workspace } from '../helpers/agent-cards.ts';
import { claudeSession, claudeSubAgent, FIX, folderOf, ompSession, ompSubAgent, sessionOf, spent, toolCalls, type OmpCall } from '../helpers/live.ts';
import { attr, figure, parts, text } from '../helpers/markup.ts';
import type { FleetAnswer } from '../../src/protocol.ts';

const MINUTE = 60_000;
// 10:00 on the day of NOW (UTC, the tests' time zone).
const AT_10 = Date.parse('2026-11-25T10:00:00.000Z');

// FIX's omp session, whose own model calls are `calls` of `model`, with one sub-agent per entry
// of `subAgents`, its name to its calls and model: the session's answer, the fleet answer and the
// session screen (`sessionOf`). `before` runs with the home once the files are written.
function withSubAgents(
  calls: OmpCall[],
  subAgents: Record<string, { calls: OmpCall[]; model?: string; init?: { at: number; kind: string }; running?: boolean }>,
  { model, before }: { model?: string; before?: (home: string, transcripts: string[]) => void } = {},
) {
  return sessionOf([FIX], {
    prepare: (home) => {
      const path = folderOf(home, FIX);
      ompSession(home, path, { title: 'Fix the login bug', calls, model });
      const transcripts = Object.entries(subAgents).map(([name, sub]) => ompSubAgent(home, path, name, sub));
      before?.(home, transcripts);
    },
  });
}

// The card of the fleet answer `fleet`, as the fleet screen draws it.
const cardOf = (fleet: FleetAnswer) => parts(fleetScreen({ groups: fleet.groups, whole: fleet }), 'data-part', 'card')[0];

// The rows of the section `part` of `html`, each as the text it shows.
const rows = (html: string, part: string) => parts(parts(html, 'data-part', part)[0], 'class', 'row item').map(text);

// The text of the figure of the figures row captioned `caption`.
const figureText = (html: string, caption: string) =>
  parts(parts(html, 'class', 'figures')[0], 'class', 'figure')
    .map(text)
    .find((shown) => shown.startsWith(caption));

test('Cost and the share of sub-agents', async () => {
  const { html } = await withSubAgents([spent(21)], { Impl1: { calls: [spent(39)] } });

  assert.equal(figure(html, 'cost'), '$60.00');
  assert.equal(figureText(html, 'Cost'), 'Cost $60.00 65% sub-agents');
});

test('Tokens and the share read from cache', async () => {
  const { html } = await withSubAgents([{ at: NOW - MINUTE, read: 1_400_000, uncached: 100_000, cost: 0.1 }], {
    Impl1: { calls: [{ at: NOW - MINUTE, read: 460_000, uncached: 40_000, cost: 0.1 }] },
  });

  assert.equal(figure(html, 'tokens'), '2M');
  assert.equal(figureText(html, 'Tokens'), 'Tokens 2M 93% from cache');
});

test('Model calls and failed tool calls', async () => {
  const callsOf = (count: number, failed: number) =>
    Array.from({ length: count }, (_, i): OmpCall => ({ ...spent(0.01, NOW - MINUTE + i), tools: [{ name: 'bash', failed: i < failed }] }));
  const { html } = await withSubAgents(callsOf(318, 9), { Impl1: { calls: callsOf(40, 2) } });

  assert.equal(figure(html, 'calls'), '318');
  assert.equal(figureText(html, 'Model calls'), 'Model calls 318 9 failed tools');
});

test('Own model calls and sub-agents as two layers', async () => {
  const { answer, html } = await withSubAgents([spent(1, AT_10), spent(2, AT_10 + 60 * MINUTE)], {
    Impl1: { calls: [spent(0.5, AT_10 + 20 * MINUTE), spent(1.5, AT_10 + 40 * MINUTE)] },
  });

  const cost = answer.session!.cost!;
  assert.deepEqual(costAt(cost, AT_10 + 30 * MINUTE), { own: 1, sub: 0.5 });
  assert.deepEqual(costAt(cost, AT_10 + 60 * MINUTE), { own: 3, sub: 2 });
  const [costCard] = parts(html, 'class', 'cost-card');
  assert.equal(figure(costCard, 'total'), '$5.00');
  assert.equal(figure(costCard, 'perHour'), '$5.00/h');
});

test('Card cost includes the sub-agents', async () => {
  const { fleet } = await withSubAgents([spent(1.2)], { Impl1: { calls: [spent(0.3)] }, Impl2: { calls: [spent(0.5)] } });

  assert.equal(figure(cardOf(fleet), 'cost'), '$2.00');
});

test('Sub-agents of sub-agents count', async () => {
  const { html } = await withSubAgents([spent(1)], { Impl1: { calls: [spent(0.5)] }, 'Impl1/Rev1': { calls: [spent(0.25)] } });

  assert.equal(figure(html, 'cost'), '$1.75');
  assert.equal(attr(parts(html, 'data-layer', 'own')[0], 'data-last'), '1');
  assert.equal(attr(parts(html, 'data-layer', 'sub')[0], 'data-last'), '0.75');
});

test('A sub-agent with no model call yet', async () => {
  // omp has written only the sub-agent's `session_init`: it has spent nothing yet
  const { fleet, html } = await withSubAgents([spent(1.2)], {
    Impl1: { calls: [spent(0.3)] },
    Impl2: { calls: [], init: { at: NOW - MINUTE, kind: 'implementer' }, running: true },
  });

  assert.equal(figure(cardOf(fleet), 'cost'), '$1.50');
  assert.equal(figure(html, 'cost'), '$1.50');
  assert.notEqual(figure(html, 'tokens'), 'n/a');
  assert.equal(figureText(html, 'Cost'), 'Cost $1.50 20% sub-agents');
  assert.equal(figure(parts(html, 'data-part', 'subagents')[0], 'subCost'), '$0.30');
});

test('Sub-agents still being read', async () => {
  let unread = '';
  try {
    const { fleet, html } = await withSubAgents(
      [spent(1.2)],
      { Impl1: { calls: [spent(0.3)] }, Impl2: { calls: [spent(0.5)] }, Impl3: { calls: [spent(0.4)] } },
      {
        // a transcript the read-only programs cannot read is not read yet
        before: (_home, transcripts) => {
          unread = transcripts[2];
          chmodSync(unread, 0o000);
        },
      },
    );

    const card = cardOf(fleet);
    assert.equal(figure(card, 'cost'), '$1.20');
    assert.match(text(card), /reading 2 of 3 sub-agents/);
    assert.doesNotMatch(text(card), /\$2\.00/);
    // the session screen shows the session's own cost the same way
    assert.equal(figureText(html, 'Cost'), 'Cost $1.20 reading 2 of 3 sub-agents');
    // no figure reads it, though the cost chart's scale, to two steps of $1.00, is labelled $2.00
    assert.doesNotMatch(text(html.replace(/<span data-label="[^"]*"[^>]*>[^<]*<\/span>/g, '')), /\$2\.00/);
  } finally {
    if (unread) chmodSync(unread, 0o644);
  }
});

test('Tool calls of sub-agents are not added', async () => {
  const { html } = await withSubAgents([{ ...spent(0.1), tools: toolCalls('bash', 10) }], { Impl1: { calls: [{ ...spent(0.1), tools: toolCalls('bash', 50) }] } });

  const [section] = parts(html, 'data-part', 'tools');
  assert.equal(text(parts(section, 'class', 'row head')[0]), 'Tools 10 tool calls');
});

test('Cost by model', async () => {
  const { html } = await withSubAgents(
    [spent(1)],
    {
      Impl1: { calls: [spent(0.4)], model: 'claude-opus-5.5-1m' },
      Impl2: { calls: [spent(0.6)], model: 'claude-opus-5.5-1m' },
      Impl3: { calls: [spent(0.1)], model: 'claude-haiku-5.5' },
    },
    { model: 'claude-fable-5.2' },
  );

  assert.deepEqual(rows(html, 'models'), [
    'anthropic/claude-fable-5.2 · main agent · $1.00',
    'anthropic/claude-opus-5.5-1m · 2 sub-agents · $1.00',
    'anthropic/claude-haiku-5.5 · 1 sub-agent · $0.10',
  ]);
});

test('Main agent and a sub-agent on one model', async () => {
  const { html } = await withSubAgents([spent(1)], { Impl1: { calls: [spent(0.5)], model: 'claude-opus-5.5-1m' } }, { model: 'claude-opus-5.5-1m' });

  assert.deepEqual(rows(html, 'models'), ['anthropic/claude-opus-5.5-1m · main agent and 1 sub-agent · $1.50']);
});

test('Tokens by model for Claude Code', async () => {
  const { html } = await sessionOf([{ project: 'web', name: 'main', agents: ['working'], harness: 'claude' }], {
    prepare: (home) => {
      const path = workspace(home, 'web-main');
      claudeSession(home, path, { calls: [{ at: NOW - 2 * MINUTE, uncached: 500_000 }], cost: 1.5 });
      claudeSubAgent(home, path, 'a1', { calls: [{ at: NOW - MINUTE, uncached: 74_880 }], model: 'haiku' });
    },
  });

  assert.deepEqual(rows(html, 'models'), ['claude-opus-4-6 · main agent · 500,000 tokens', 'haiku · 1 sub-agent · 74,880 tokens']);
  assert.doesNotMatch(text(parts(html, 'data-part', 'models')[0]), /\$/);
});
