// Both screens at the panel's narrowest width, 300 px: every chart is an SVG as wide as its box
// with no text of its own, and the stylesheet keeps every text and figure from being cut off: no
// `nowrap`, no `text-overflow` and no width over 300 px. The Node tests have no layout to measure,
// so this pins the markup and the stylesheet that the layout follows, drawn from the real worker's
// answer over omp sessions under a temporary home (test/helpers/live.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STYLE } from '../../src/live/style.ts';
import { NOW } from '../helpers/agent-cards.ts';
import { FIX, fleetOf, folderOf, ompSession, ompSubAgent, ompWindow, sessionOf, toolCalls } from '../helpers/live.ts';
import { parts } from '../helpers/markup.ts';
import type { HostWorkspace } from '../helpers/orca-host.ts';

const MINUTE = 60_000;

// Every chart of `html` is as wide as its box, with a view box and no text of its own, and the
// stylesheet cuts off no text and sets no width over 300 px.
function assertFits(html: string) {
  const svgs = html.match(/<svg[^>]*>/g) ?? [];
  for (const svg of svgs) {
    assert.match(svg, / width="100%"/);
    assert.match(svg, / viewBox="0 0 \d+ \d+"/);
  }
  assert.doesNotMatch(html, /<text/);
  assert.doesNotMatch(STYLE, /nowrap|text-overflow/);
  const widths = [...STYLE.matchAll(/(?:width:\s*|minmax\()(\d+(?:\.\d+)?)px/g)].map(([, px]) => Number(px));
  assert.ok(widths.every((px) => px <= 300), `a width over 300 px: ${widths}`);
}

test('Fleet screen 300 px wide', async () => {
  const done: HostWorkspace = { project: 'api', name: 'docs', agents: ['done'], title: 'π - Write the docs' };
  const { html } = await fleetOf([FIX, done], {
    prepare: (home) => {
      ompWindow(home, 1_000_000);
      ompSession(home, folderOf(home, FIX), { title: 'Fix the login bug', calls: [{ at: NOW - MINUTE, output: 100, cost: 0.1, context: 800_000 }] });
      ompSession(home, folderOf(home, done), { title: 'Write the docs', calls: [{ at: NOW - 2 * MINUTE, output: 100, cost: 0.1, context: 100_000 }] });
    },
  });

  assert.equal(parts(html, 'data-chart', 'burn').length, 1);
  assert.equal(parts(parts(html, 'data-part', 'attention')[0] ?? '', 'data-row').length, 1);
  assert.equal(parts(html, 'data-part', 'card').length, 1);
  assert.equal(parts(html, 'data-part', 'folded').length, 1);
  assertFits(html);
});

test('Session screen 300 px wide', async () => {
  const { html } = await sessionOf([FIX], {
    prepare: (home) => {
      const path = folderOf(home, FIX);
      ompWindow(home, 1_000_000);
      ompSession(home, path, {
        title: 'Fix the login bug',
        calls: Array.from({ length: 6 }, (_, i) => ({ at: NOW - (30 - i) * MINUTE, read: 1000 * i, uncached: 500, output: 100, cost: 0.1, context: 100_000 * (i + 1), tools: toolCalls('bash', 2, 1) })),
        compactions: [{ at: NOW - 27 * MINUTE + 30_000, before: 300_000, after: 50_000 }],
      });
      ompSubAgent(home, path, 'Impl1', { init: { at: NOW - 20 * MINUTE, kind: 'implementer', task: 'write the code' }, running: true, calls: [{ at: NOW - 19 * MINUTE, output: 100, cost: 0.2 }] });
      ompSubAgent(home, path, 'Rev1', { init: { at: NOW - 18 * MINUTE, kind: 'reviewer' }, calls: [{ at: NOW - 17 * MINUTE, output: 100, cost: 0.1 }] });
    },
  });

  for (const chart of ['context', 'tokens', 'cost', 'subagents']) assert.ok(parts(html, 'data-chart', chart).length > 0, `no ${chart} chart`);
  assert.ok(parts(html, 'data-part', 'tools').length > 0);
  assertFits(html);
});
