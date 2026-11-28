// Claude Code sessions in the history store: the real worker's first catch-up reads the Claude
// Code session files under a temporary home, each day's cost from the session's `cost-state`
// deltas, and the Spend tab is drawn from the answer it gives (test/helpers/history.ts). The list
// by model is read from the store's daily lines over the range.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { rangeOf, storeOf } from '../helpers/history.ts';
import { type ClaudeCall, type CostState, claudeSession, claudeSubAgent } from '../helpers/live.ts';
import { attr, figure, parts } from '../helpers/markup.ts';

// The clock of these tests: 2026-11-28 15:00 UTC.
const CLOCK = Date.parse('2026-11-28T15:00:00.000Z');

// Epoch ms of `hhmm` UTC on `day` (YYYY-MM-DD).
const on = (day: string, hhmm = '12:00') => Date.parse(`${day}T${hhmm}:00.000Z`);

// A model call at `at` of 1,000 output tokens.
const call = (at: number): ClaudeCall => ({ at, output: 1000 });

// Rounded to the cent, against the sums' floating-point error.
const cents = (usd: number) => Math.round(usd * 100) / 100;

// Each day of the Spend tab's cost chart in `html`, to the cent.
function costByDay(html: string) {
  const [chart] = parts(html, 'data-chart', 'range-cost');
  return Object.fromEntries(parts(chart, 'data-key').map((point) => [attr(point, 'data-key'), cents(Number(attr(point, 'data-v')))]));
}

// The Week's Spend tab over the Claude Code session that `write` puts under the home, and the
// cost by model the store's daily lines of the week give, to the cent.
async function weekOf(write: (home: string, folder: string) => void) {
  let home = '';
  const { html } = await rangeOf([], {
    tab: 'spend',
    range: 'week',
    now: CLOCK,
    prepare: (at) => {
      home = at;
      write(home, join(home, 'api'));
    },
  });
  const db = storeOf(home);
  const rows = db.prepare("SELECT model, SUM(cost) AS cost FROM daily_lines WHERE day BETWEEN '2026-11-22' AND '2026-11-28' GROUP BY model").all();
  db.close();
  return { html, models: Object.fromEntries(rows.map(({ model, cost }) => [String(model), cents(Number(cost))])) };
}

const OPUS = 'claude-opus-5-5';

test('Cost of each day', async () => {
  const costStates: CostState[] = [
    { at: on('2026-11-26', '10:00') + 1, models: { [OPUS]: 1 } },
    { at: on('2026-11-26') + 1, models: { [OPUS]: 2, 'claude-sonnet-5': 0.5 } },
    { at: on('2026-11-27') + 1, models: { [OPUS]: 5, 'claude-sonnet-5': 0.5, 'claude-haiku-4-5': 0.2 } },
  ];
  const calls = [call(on('2026-11-26', '10:00')), call(on('2026-11-26')), call(on('2026-11-27'))];

  const { html, models } = await weekOf((home, folder) => claudeSession(home, folder, { calls, model: OPUS, costStates }));

  const days = costByDay(html);
  assert.equal(days['2026-11-26'], 2.5);
  assert.equal(days['2026-11-27'], 3.2);
  assert.deepEqual(models, { [OPUS]: 5, 'claude-sonnet-5': 0.5, 'claude-haiku-4-5': 0.2 });
});

test('Day without a cost-state', async () => {
  const costStates: CostState[] = [
    { at: on('2026-11-26') + 1, models: { [OPUS]: 2 } },
    { at: on('2026-11-28') + 1, models: { [OPUS]: 3 } },
  ];
  const calls = [call(on('2026-11-26')), call(on('2026-11-27')), call(on('2026-11-28'))];

  const { html } = await weekOf((home, folder) => claudeSession(home, folder, { calls, model: OPUS, costStates }));

  const days = costByDay(html);
  assert.equal(days['2026-11-27'], 0);
  assert.equal(days['2026-11-28'], 1);
});

test('a Claude Code sub-agent counts its tokens, not a cost', async () => {
  const { html } = await weekOf((home, folder) => {
    claudeSession(home, folder, { calls: [call(on('2026-11-28'))], model: OPUS, costStates: [{ at: on('2026-11-28') + 1, models: { [OPUS]: 1 } }] });
    claudeSubAgent(home, folder, 'a1', { calls: [{ at: on('2026-11-28', '12:30'), output: 74_880 }], model: 'claude-haiku-4-5' });
  });

  assert.equal(figure(html, 'tokens'), '75,880');
  assert.equal(figure(html, 'cost'), '$1.00');
});

test('a Claude Code response written as several blocks counts once', async () => {
  const { html } = await weekOf((home, folder) => {
    claudeSession(home, folder, { calls: [call(on('2026-11-28'))], model: OPUS, costStates: [{ at: on('2026-11-28') + 1, models: { [OPUS]: 1 } }] });
    // Claude Code writes a response as one entry per content block, each with its usage
    const file = claudeSubAgent(home, folder, 'a1', { calls: [{ at: on('2026-11-28', '12:30'), output: 500 }], model: 'claude-haiku-4-5' });
    appendFileSync(file, readFileSync(file, 'utf8'));
  });

  assert.equal(figure(html, 'tokens'), '1,500');
  assert.equal(figure(html, 'calls'), '2');
});
