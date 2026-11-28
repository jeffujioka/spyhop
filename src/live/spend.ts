// The Spend tab of the live panel, as markup: the range's cost, with where it comes from when part
// of it is from GitHub prices, tokens, model calls and side calls' cost; for Week, Month and Year
// its cost over time; and its cost by repo, model and harness, each under its title and the line
// of what it means.
// Pure: an answer in, a markup string out.

import { formatCost, formatCount, orNa } from '../core/format.js';
import type { RangeAnswer, SpendRow, SpendView } from '../protocol.ts';
import { rangeChart, usdLabel } from './charts.ts';
import { costPart, esc, NAMED_ROWS, num, titled, topRows } from './html.ts';

// Where the cost comes from, only when part of it is from GitHub prices: that part, then the rest
// as the harnesses logged it.
function sourcesOf(sources: SpendView['sources']) {
  if (!sources) return '';
  const copilot = costPart('copilot', sources.copilot, 'from tokens at GitHub prices');
  return copilot && `${copilot}${costPart('logged', sources.logged, 'as the harness logged it')}`;
}

// The list `key` (`data-list`) of `rows` under its title and meaning, the NAMED_ROWS costliest by
// name and the rest as `others`; '' without a row.
function list(key: string, title: string, meaning: string, rows: SpendRow[]) {
  if (rows.length === 0) return '';
  const shown = topRows(rows.map(({ name, cost }) => ({ name, values: [cost] })), NAMED_ROWS);
  const items = shown.map(({ name, values: [cost] }) => `<div class="row item"><span class="grow">${esc(name)}</span><span class="num">${formatCost(cost)}</span></div>`);
  return titled(title, meaning, `<div data-list="${key}">${items.join('')}</div>`);
}

// The Spend tab of `answer`; '' when it holds no Spend tab.
export function spendTab({ range, spend }: RangeAnswer): string {
  if (!spend) return '';
  const { cost, tokens, calls, chart, byRepo, byModel, byHarness, sideCost, sources } = spend;
  const figures =
    `<div class="figures">` +
    titled('What the range cost', 'Every harness session on every Orca host, sub-agents included', `${num('cost', formatCost(cost))}${sourcesOf(sources)}`) +
    titled('Tokens', 'Prompt and output tokens of every model call, cached ones included', num('tokens', orNa(tokens, formatCount))) +
    titled('Model calls', 'Every call to a model, sub-agents included', num('calls', orNa(calls, formatCount))) +
    titled('Side calls', "What omp's side calls, such as titles and recaps, cost of the range's cost", num('sideCost', formatCost(sideCost))) +
    `</div>`;
  const over = chart
    ? titled('Cost over time', range === 'year' ? 'What each month cost' : 'What each day cost', rangeChart('cost', chart, formatCost, usdLabel))
    : '';
  const lists =
    list('repo', 'By repo', 'What each repo cost, by its origin, else its folder', byRepo) +
    list('model', 'By model', 'What each model cost, with its provider where the harness logs one', byModel) +
    list('harness', 'By harness', 'What each harness cost', byHarness);
  return `${figures}${over}${lists}`;
}
