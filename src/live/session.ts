// The session screen of the live panel, as markup: the header, with the back control, the Orca
// state and the title, and the Focus button when the agent has a pane; the four figures; the
// context, tokens and cost cards; then the Tools, Models and Session sections. A part with
// nothing to show is not drawn; a figure that cannot be read reads n/a. Until the session is
// answered, the header is the fleet's card's and the screen says it is loading.
// Pure: an answer in, a markup string out (src/panel.ts draws it).

import { formatAge, formatCost, formatCount, formatDate, formatDay, formatDuration, formatPercent, formatSeconds, formatTokens, orNa } from '../core/format.js';
import type { CardView, SessionView } from '../protocol.ts';
import { contextChart, costChart, tokensChart } from './charts.ts';
import { esc, num } from './html.ts';

// The tools the Tools section names, the most called first; the rest are summed as `others`.
export const TOP_TOOLS = 6;

// What the screen is drawn with besides the answer: the fleet's card of the session, for the
// header before the answer is in; `showAll`: whether every sub-agent is listed.
export type SessionUi = { card: CardView | null; showAll: boolean };

const BACK = '<button type="button" data-press="back" class="back" aria-label="Back">‹</button>';

// The header of `card`, whose folder reads `path`; only the back control without a card.
function header(card: CardView | null, path: string) {
  if (!card) return `<header data-part="header"><div class="row">${BACK}</div></header>`;
  const meta = `${[card.harness, card.model, path, card.state].map(esc).join(' · ')} · ${num('since', formatAge(card.stateSinceMs))}`;
  const focus = card.pane ? '<button type="button" data-press="focus" class="focus">Focus ↗</button>' : '';
  return (
    `<header data-part="header" data-state="${esc(card.state)}"><div class="row">${BACK}<i class="dot"></i>` +
    `<b class="title grow">${esc(card.title)}</b>${focus}</div><div class="meta">${meta}</div></header>`
  );
}

// The figures row: each figure under its caption, with its line under it.
function figures({ cost, subShare, tokens, cacheShare, calls, failedTools, durationMs, startMs }: SessionView['figures']) {
  const items = [
    ['Cost', num('cost', formatCost(cost)), `${num('subShare', formatPercent(subShare))} sub-agents`],
    ['Tokens', num('tokens', orNa(tokens, formatTokens)), `${num('cacheShare', formatPercent(cacheShare))} from cache`],
    ['Model calls', num('calls', formatCount(calls)), `${num('failedTools', formatCount(failedTools))} failed tools`],
    ['Duration', num('duration', formatDuration(durationMs)), num('start', formatDay(startMs))],
  ];
  return `<div class="figures">${items.map(([caption, value, line]) => `<div class="figure"><div class="muted">${caption}</div>${value}<div class="muted">${line}</div></div>`).join('')}</div>`;
}

// The cost card: the cost chart, and the total with where it comes from, the one place of the
// panel that says so. The stylesheet puts the total under the chart's title.
function costCard(cost: NonNullable<SessionView['cost']>) {
  return `<div class="cost-card">${costChart(cost)}<div class="row headline">${num('total', formatCost(cost.total))}<span class="muted">as ${esc(cost.harness)} logged it</span></div></div>`;
}

// A section's heading: its title, with `aside` beside it.
const heading = (title: string, aside: string) => `<div class="row head"><b class="grow">${title}</b><span class="muted">${aside}</span></div>`;

// `count` failed, after a separator, only when there is one.
const failedOf = (count: number, before = '') => (count > 0 ? `${before}<span class="failed"><span class="num">${formatCount(count)}</span> failed</span>` : '');

// The session's own tool calls: the TOP_TOOLS most called by name, the rest summed as `others`.
function tools({ calls, failed, byTool }: NonNullable<SessionView['tools']>) {
  const rest = byTool.slice(TOP_TOOLS);
  const others = { name: 'others', calls: rest.reduce((sum, tool) => sum + tool.calls, 0), failed: rest.reduce((sum, tool) => sum + tool.failed, 0) };
  const shown = rest.length === 0 ? byTool : [...byTool.slice(0, TOP_TOOLS), others];
  const items = shown.map((tool) => `<div class="row item"><span class="grow">${esc(tool.name)}</span><span class="num">${formatCount(tool.calls)}</span>${failedOf(tool.failed)}</div>`);
  return `<section data-part="tools" class="box">${heading('Tools', `${num('toolCalls', formatCount(calls))} tool call${calls === 1 ? '' : 's'}${failedOf(failed, ' · ')}`)}${items.join('')}</section>`;
}

// The cost, or the tokens, by model, each with what used it: the main agent and the sub-agents.
function models({ by, rows }: SessionView['models']) {
  if (rows.length === 0) return '';
  const items = rows.map(({ model, main, subAgents, value }) => {
    const users = [main ? 'main agent' : '', subAgents > 0 ? `<span class="num">${subAgents}</span> sub-agent${subAgents === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    // the tokens are a figure and the word after them text
    const shown = by === 'tokens' && value !== 'n/a' ? `<span class="num">${formatCount(value)}</span> tokens` : `<span class="num">${by === 'cost' ? formatCost(value) : value}</span>`;
    return `<div class="row item"><span>${esc(model)}</span> · <span class="muted grow">${users}</span> · <span>${shown}</span></div>`;
  });
  return `<section data-part="models" class="box">${heading('Models', `by ${by}`)}${items.join('')}</section>`;
}

// The Session section: the Branch, the Remote and the Orca host only where there is one.
// The times and counts are figures (`.num`); the thinking level, branch, remote and host are words,
// set in the text font, still named by `data-figure` so they can be read like the figures.
function session({ startedMs, thinking, latencyMs, premium, branch, remote, host }: SessionView['session']) {
  const word = (name: string, value: string | null) => (value === null ? null : `<span data-figure="${name}">${esc(value)}</span>`);
  const items: [string, string | null][] = [
    ['Started', num('started', formatDate(startedMs))],
    ['Thinking', word('thinking', thinking)],
    ['Last reply', num('latency', formatSeconds(latencyMs))],
    ['Premium', num('premium', formatCount(premium))],
    ['Branch', word('branch', branch)],
    ['Remote', word('remote', remote)],
    ['Host', word('host', host)],
  ];
  const drawn = items.flatMap(([label, value]) => (value === null ? [] : [`<div class="row item"><span class="muted grow">${label}</span>${value}</div>`]));
  return `<section data-part="session" class="box">${heading('Session', '')}${drawn.join('')}</section>`;
}

export function sessionScreen(view: SessionView | null, { card }: SessionUi): string {
  if (!view) return `<main data-screen="session">${header(card, card?.folder ?? '')}<p data-part="loading" class="muted">Reading the session…</p></main>`;
  return (
    `<main data-screen="session">${header(view.card, view.path)}${figures(view.figures)}` +
    `${view.context ? contextChart(view.context) : ''}${view.tokens ? tokensChart(view.tokens) : ''}${view.cost ? costCard(view.cost) : ''}` +
    `${view.tools ? tools(view.tools) : ''}${models(view.models)}${session(view.session)}</main>`
  );
}
