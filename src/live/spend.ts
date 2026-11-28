// The Spend tab of the live panel, as markup: what the running catch-up is reading, of a host and
// harness never read through, and the Orca hosts the last catch-up could not read, when there are
// any; the range's cost, with where it comes from when part of it is from GitHub
// prices, tokens, model calls and side calls' cost; for Week, Month and Year its cost over time;
// and its cost by repo, model and harness, each under its title and the line of what it means;
// then its costliest sessions, each a row that opens its session's screen.
// Pure: an answer in, a markup string out.

import { formatCost, formatCount, formatPercent, orNa } from '../core/format.js';
import type { CostlySession, RangeAnswer, SpendRow, SpendView } from '../protocol.ts';
import { rangeChart, usdLabel } from './charts.ts';
import { costPart, esc, NAMED_ROWS, num, pressable, titled, topRows } from './html.ts';

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

// The costliest sessions: a row each, which opens its Live card's session screen, or else the
// screen of the past session; '' without a row.
function costliestList(sessions: CostlySession[]) {
  if (sessions.length === 0) return '';
  const words = (name: string, value: string) => `<span class="muted" data-figure="${name}">${esc(value)}</span>`;
  const rows = sessions.map(
    ({ id, title, repo, harness, host, cost, card }) =>
      `<div data-part="costly" ${card === null ? pressable('past', id) : pressable('open', card)} class="row item"><b class="title grow">${esc(title)}</b>` +
      `${words('repo', repo)}${words('harness', harness)}${words('host', host)}${num('sessionCost', formatCost(cost))}</div>`,
  );
  return titled('Costliest sessions', 'The sessions that logged a model call in the range, by what they cost with their sub-agents', `<div data-list="costliest">${rows.join('')}</div>`);
}

// The Spend tab of `answer`; '' when it holds no Spend tab.
export function spendTab({ range, spend, notRead, progress }: RangeAnswer): string {
  if (!spend) return '';
  const reading = progress
    ? `<p data-part="progress" class="muted">Reading history: ${esc(progress.host)}, ${esc(progress.harness)}, ${formatPercent(progress.share)}</p>`
    : '';
  const unread = notRead.length > 0 ? `<p data-part="not-read" class="muted">Not read this time: ${esc(notRead.join(', '))}. Their figures are those read before.</p>` : '';
  const { cost, tokens, calls, chart, byRepo, byModel, byHarness, costliest, sideCost, sources } = spend;
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
    list('harness', 'By harness', 'What each harness cost', byHarness) +
    costliestList(costliest);
  return `${reading}${unread}${figures}${over}${lists}`;
}
