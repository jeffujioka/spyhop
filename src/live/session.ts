// The session screen of the live panel, as markup, under the tab bar with Live shown: the header,
// with the back control, the Orca
// state and the title, and the Focus button when the agent has a pane; the four figures; the
// context, tokens and cost cards; then the Sub-agents, Tools, Models and Session sections. A part
// with nothing to show is not drawn; a figure that cannot be read reads n/a. While the session's
// sub-agents are being read, its cost says how many are. Until the session is answered, the
// header is the fleet's card's and the screen says it is loading.
// Pure: an answer in, a markup string out (src/panel.ts draws it).

import { formatAge, formatCost, formatCostPerHour, formatCount, formatDate, formatDay, formatDuration, formatPercent, formatSeconds, formatTokens, orNa } from '../core/format.js';
import type { CardView, SessionView, SubAgentView } from '../protocol.ts';
import { agentBars, contextChart, costChart, tokensChart } from './charts.ts';
import { readingNote } from './fleet.ts';
import { costPart, esc, NAMED_ROWS, num, topRows } from './html.ts';
import { tabBar } from './tabs.ts';

// The sub-agents the Sub-agents section draws a bar of, those that started last, unless every
// one is asked for.
export const RECENT_BARS = 8;

// The colours of sub-agent kinds (`--spy-k1..k6`), given in turn to the kinds of a session.
const KIND_COLOURS = 6;

// What the screen is drawn with besides the answer: the fleet's card of the session, for the
// header before the answer is in; `showAll`: whether every sub-agent is listed; `now`: epoch ms,
// from which a running sub-agent's time is told.
export type SessionUi = { card: CardView | null; showAll: boolean; now: number };

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

// The figures row: each figure under its caption, with its line under it; under the cost, while
// the sub-agents are being read (`reading`), how many are.
function figures({ cost, subShare, tokens, cacheShare, calls, failedTools, durationMs, startMs }: SessionView['figures'], reading: CardView['reading']) {
  const items = [
    ['Cost', num('cost', formatCost(cost)), reading ? readingNote(reading) : `${num('subShare', formatPercent(subShare))} sub-agents`],
    ['Tokens', num('tokens', orNa(tokens, formatTokens)), `${num('cacheShare', formatPercent(cacheShare))} from cache`],
    ['Model calls', num('calls', formatCount(calls)), `${num('failedTools', formatCount(failedTools))} failed tools`],
    ['Duration', num('duration', formatDuration(durationMs)), num('start', formatDay(startMs))],
  ];
  return `<div class="figures">${items.map(([caption, value, line]) => `<div class="figure"><div class="muted">${caption}</div>${value}<div class="muted">${line}</div></div>`).join('')}</div>`;
}

// The cost card: the cost chart, and the total and the cost per hour; under them, where the total
// comes from, the one place of the panel that says so: the part from tokens at GitHub prices and
// the part as the harness logged it, each left out when it is 0 (under half a cent) or not known;
// then, when the harness logged part of the session's cost without a model call, how much, which
// the chart does not draw. The stylesheet puts them under the chart's title.
function costCard(cost: NonNullable<SessionView['cost']>, { copilot, logged }: SessionView['costFrom']) {
  const noCall = cost.noCall === null ? '' : `<div class="muted">${num('noCall', formatCost(cost.noCall))} logged without a model call</div>`;
  return (
    `<div class="cost-card">${costChart(cost)}<div class="row headline">${num('total', formatCost(cost.total))}` +
    `<span class="grow"></span>${num('perHour', formatCostPerHour(cost.perHour))}</div>` +
    `${costPart('copilot', copilot, 'from tokens at GitHub prices')}${costPart('logged', logged, `as ${esc(cost.harness)} logged it`)}${noCall}</div>`
  );
}

// A section's heading: its title, with `aside` beside it.
const heading = (title: string, aside: string) => `<div class="row head"><b class="grow">${title}</b><span class="muted">${aside}</span></div>`;

// `count` failed, after a separator, only when there is one.
const failedOf = (count: number, before = '') => (count > 0 ? `${before}<span class="failed"><span class="num">${formatCount(count)}</span> failed</span>` : '');

// The bars of the session's sub-agents `agents`, in the order they started: of the RECENT_BARS
// that started last, with how many started earlier and `Show all`, or of every one (`showAll`).
// Each kind has its colour, in the order the kinds first appear, the colours given again in
// turn past KIND_COLOURS.
export function subAgentBars(agents: SubAgentView[], showAll: boolean): string {
  const kinds = new Map<string, number>();
  for (const { kind } of agents) if (!kinds.has(kind)) kinds.set(kind, (kinds.size % KIND_COLOURS) + 1);
  const earlier = showAll ? 0 : Math.max(0, agents.length - RECENT_BARS);
  const more =
    earlier > 0
      ? `<div class="row more"><span class="muted grow"><span class="num">${formatCount(earlier)}</span> earlier</span><button type="button" data-press="all">Show all</button></div>`
      : '';
  return `${agentBars(agents.slice(earlier), kinds)}${more}`;
}

// The Sub-agents section: how many run, when the harness tells it, how many there are and their
// cost; a row of each running one, with its kind, name, task, how long it has run by `now` and
// its cost; then the bars (`subAgentBars`).
function subAgents({ running, total, cost, agents }: NonNullable<SessionView['subAgents']>, { showAll, now }: SessionUi) {
  const counts = [
    running === 'n/a' ? '' : `${num('running', formatCount(running))} running · `,
    `${num('subAgents', formatCount(total))} in total · ${num('subCost', formatCost(cost))}`,
  ];
  const rows = agents
    .filter((agent) => agent.running === true)
    .map(({ kind, name, task, startMs, cost: spent }) => {
      const ran = startMs === 'n/a' ? startMs : now - startMs;
      return `<div class="row item"><span>${esc(kind)}</span> · <span>${esc(name)}</span> · <span class="grow">${esc(task)}</span> · <span class="num">${formatAge(ran)}</span> · <span class="num">${formatCost(spent)}</span></div>`;
    });
  return `<section data-part="subagents" class="box">${heading('Sub-agents', counts.join(''))}${rows.join('')}<div class="agents">${subAgentBars(agents, showAll)}</div></section>`;
}

// The session's own tool calls: the NAMED_ROWS most called by name, the rest summed as `others`.
function tools({ calls, failed, byTool }: NonNullable<SessionView['tools']>) {
  const rows = topRows(byTool.map((tool) => ({ name: tool.name, values: [tool.calls, tool.failed] })), NAMED_ROWS);
  // a tool's counts are never n/a, so neither are their sums
  const items = rows.map(({ name, values: [count, fails] }) => `<div class="row item"><span class="grow">${esc(name)}</span><span class="num">${formatCount(count)}</span>${failedOf(fails as number)}</div>`);
  return `<section data-part="tools" class="box">${heading('Tools', `${num('toolCalls', formatCount(calls))} tool call${calls === 1 ? '' : 's'}${failedOf(failed, ' · ')}`)}${items.join('')}</section>`;
}

// The cost by model, each with what used it, where the harness says: the main agent, the
// sub-agents and the side calls.
function models({ by, rows }: SessionView['models']) {
  if (rows.length === 0) return '';
  const items = rows.map(({ model, main, subAgents, sideCalls, value }) => {
    const users = [main ? 'main agent' : '', subAgents > 0 ? `<span class="num">${subAgents}</span> sub-agent${subAgents === 1 ? '' : 's'}` : '', sideCalls ? 'side calls' : ''].filter(Boolean).join(' and ');
    const named = users ? `<span>${esc(model)}</span> · <span class="muted grow">${users}</span>` : `<span class="grow">${esc(model)}</span>`;
    return `<div class="row item">${named} · <span><span class="num">${formatCost(value)}</span></span></div>`;
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

export function sessionScreen(view: SessionView | null, ui: SessionUi): string {
  const { card } = ui;
  if (!view) return `<main data-screen="session">${tabBar('live', null)}${header(card, card?.folder ?? '')}<p data-part="loading" class="muted">Reading the session…</p></main>`;
  return (
    `<main data-screen="session">${tabBar('live', null)}${header(view.card, view.path)}${figures(view.figures, view.card.reading)}` +
    `${view.context ? contextChart(view.context) : ''}${view.tokens ? tokensChart(view.tokens) : ''}${view.cost ? costCard(view.cost, view.costFrom) : ''}` +
    `${view.subAgents ? subAgents(view.subAgents, ui) : ''}${view.tools ? tools(view.tools) : ''}${models(view.models)}${session(view.session)}</main>`
  );
}
