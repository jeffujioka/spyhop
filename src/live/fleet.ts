// The fleet screen of the live panel, as markup: the header, with the number of agents in each
// Orca state, the burn rate card and the attention list, all once the whole fleet is answered,
// then each Orca host's group of sessions, a card per session whose agent is not done and a folded
// line per done one. Each card, folded line and row of the attention list opens its session's
// screen when pressed. Groups only: no Orca project or workspace row. A card whose sub-agents are
// still being read says how many are, beside its own cost, and a folded line in place of its cost;
// a card's burn rate is beside that cost; its chips tell how close its context is to an
// autocompaction, its sub-agents and its cache hit rate.
// Pure: an answer in, a markup string out (src/panel.ts draws it).

import { formatAge, formatCost, formatCostPerHour, formatCount, formatCountdown, formatPercent, formatTokens, orNa } from '../core/format.js';
import { NA } from '../core/providers/index.js';
import { atAttention, STATES } from '../fleet.ts';
import type { AttentionRow, BurnCard, CardView, FleetAnswer, HostGroup } from '../protocol.ts';
import { burnChart, contextBar, sparkLine } from './charts.ts';
import { esc, num } from './html.ts';
import { levelOf } from './levels.ts';

// The groups drawn so far, and the whole answer once it is in; the counts, the burn rate card and
// the attention list come only from it.
export type FleetView = { groups: HostGroup[]; whole: FleetAnswer | null };

function counts({ counts }: FleetAnswer) {
  const known = STATES.filter((state) => counts[state] !== undefined);
  const items = known.map((state) => `<span data-state="${state}"><i class="dot"></i> ${num(state, String(counts[state]))} ${state}</span>`);
  return `<p data-part="counts">${items.join(' · ')}</p>`;
}

// The burn rate card: the cost per hour of the last 10 minutes and the whole cost of the sessions
// shown, the chart of the last hour, the tokens per minute, the cache hit rate and the sub-agents
// that run, and how many sessions the rate leaves out, when it leaves out any.
function burnCard({ perHour, total, tokensPerMin, cacheHitRate, running, leftOut, layers, endMs }: BurnCard) {
  const left =
    leftOut === 0
      ? ''
      : `<div class="muted">the rate leaves out ${num('leftOut', String(leftOut))} session${leftOut === 1 ? '' : 's'} of Claude Code, which logs no cost per model call</div>`;
  return (
    `<section data-part="burn" class="chart"><div class="row"><b class="grow">Burn rate</b><span class="muted">all sessions ${num('total', formatCost(total))}</span></div>` +
    `<div class="row headline">${num('perHour', formatCostPerHour(perHour), 'hero')} <span class="muted">per hour, last 10 minutes</span></div>${burnChart(layers, endMs)}` +
    `<div class="row key muted"><span>${num('tokensPerMin', orNa(tokensPerMin, formatTokens))} tokens/min</span><span>cache ${num('cacheHitRate', formatPercent(cacheHitRate))}</span>` +
    `<span>${num('running', formatCount(running))} sub-agent${running === 1 ? '' : 's'} running</span></div>${left}</section>`
  );
}

// The card's context: with a window, its percent, the tokens of the window, the bar and the spark
// line; without one, the tokens and the spark line.
function context({ context: { tokens, window, percent, compactAt, spark } }: CardView) {
  const used = num('tokens', orNa(tokens, formatTokens));
  const head =
    window === 'n/a'
      ? `<span class="muted">Context</span> ${used}`
      : `<span class="muted">Context</span> ${num('percent', formatPercent(percent), typeof percent === 'number' ? `lvl-${levelOf(percent)}` : '')} ${used} / ${num('window', formatTokens(window))}`;
  const bar = typeof percent === 'number' ? contextBar(percent, compactAt) : '';
  return `<div class="context"><div class="row">${head}</div>${bar}${sparkLine(spark)}</div>`;
}

// The card's chips: the tokens left before the harness compacts on its own, from the percent of
// the window where the attention list gives the session a row (src/fleet.ts), when they are known;
// how many sub-agents run and how many there are, or how many there are when the harness does not
// tell which run, none without a sub-agent; and the cache hit rate.
function chips({ context: { percent }, tokensLeft, subAgents, cacheHitRate }: CardView) {
  const warning =
    typeof percent === 'number' && atAttention(percent) && typeof tokensLeft === 'number'
      ? `<span data-chip="warning" class="lvl-${levelOf(percent)}"><span class="num">${formatTokens(tokensLeft)}</span> left</span>`
      : '';
  const count = (n: number) => `<span class="num">${formatCount(n)}</span>`;
  const agents = !subAgents
    ? ''
    : subAgents.running === 'n/a'
      ? `<span data-chip="subagents">${count(subAgents.total)} sub-agent${subAgents.total === 1 ? '' : 's'}</span>`
      : `<span data-chip="subagents">${count(subAgents.running)} sub-agent${subAgents.running === 1 ? '' : 's'} running</span><span data-chip="subagents">${count(subAgents.total)} in total</span>`;
  return `<div class="row chips">${warning}${agents}<span data-chip="cache">cache <span class="num">${formatPercent(cacheHitRate)}</span></span></div>`;
}

// How many of a session's sub-agent transcripts are read, while some are not: the card and the
// session screen write it where the cost with sub-agents will be.
export function readingNote({ read, total }: NonNullable<CardView['reading']>): string {
  return `reading <span class="num">${read}</span> of <span class="num">${total}</span> sub-agent${total === 1 ? '' : 's'}`;
}

// The attributes that make a card, a folded line or a row of the attention list the control that
// opens the session screen of the card `id`: a block cannot go inside a <button>, so it is a
// button by its role, which the keyboard reaches (`tabindex`) and presses (src/panel.ts). Its
// `data-press` value is encoded, since the id holds a NUL, `::` and slashes.
const opens = (id: string) => `role="button" tabindex="0" data-press="${esc(`open:${encodeURIComponent(id)}`)}"`;

function card(view: CardView) {
  const where = [view.folder, view.branch, view.harness, view.model].filter((part) => part !== null).map(esc).join(' · ');
  return (
    `<article data-part="card" data-state="${esc(view.state)}" ${opens(view.id)}>` +
    `<div class="row"><i class="dot"></i><b class="title grow">${esc(view.title)}</b>${num('cost', formatCost(view.cost))}<span class="muted">${num('burnPerHour', formatCostPerHour(view.burnPerHour))}</span></div>` +
    `<div class="row meta"><span class="grow">${where}</span><span>${esc(view.state)} · ${num('since', formatAge(view.stateSinceMs))}</span></div>` +
    `${view.reading ? `<div class="row meta">${readingNote(view.reading)}</div>` : ''}${context(view)}${chips(view)}</article>`
  );
}

// The folded line of a done session: its title, folder, context and cost. The context is the
// percent of the window, or without a window the tokens used. While its sub-agent transcripts are
// not all read, how many are stands where the cost goes: the session's own cost alone would pass
// for its whole cost.
function folded(view: CardView) {
  const { tokens, window, percent } = view.context;
  const used = window === 'n/a' ? num('tokens', orNa(tokens, formatTokens)) : num('percent', formatPercent(percent));
  const cost = view.reading
    ? `<span class="muted">reading <span class="num">${view.reading.read}</span>/<span class="num">${view.reading.total}</span></span>`
    : num('cost', formatCost(view.cost));
  return (
    `<div data-part="folded" data-state="${esc(view.state)}" ${opens(view.id)} class="row"><i class="dot"></i>` +
    `<span class="title grow">${esc(view.title)}</span><span class="muted">${esc(view.folder)}</span>` +
    `${used}${cost}</div>`
  );
}

// A row of the attention list: its kind, or the agent's state, the session's title, and what the
// row is for: how long the agent has been in its state; the context's percent of the window and,
// when known, the tokens left before the harness compacts on its own; or the time left until the
// prompt cache is cold, as the 2-second refresh counts it down, and the context the next model
// call then writes to it again.
function attentionRow(row: AttentionRow) {
  let tag: string;
  let figures: string;
  if (row.kind === 'state') {
    tag = row.state!;
    figures = num('since', formatAge(row.sinceMs ?? NA));
  } else if (row.kind === 'context') {
    tag = 'context';
    const left = typeof row.tokensLeft === 'number' ? ` · ${num('tokensLeft', formatTokens(row.tokensLeft))} left` : '';
    figures = `<span>${num('percent', formatPercent(row.percent!), `lvl-${levelOf(row.percent!)}`)}${left}</span>`;
  } else {
    tag = 'cache';
    figures = `<span>cold in ${num('coldIn', formatCountdown(row.coldInMs!))} · ${num('rewriteTokens', orNa(row.rewriteTokens!, formatTokens))} to write again</span>`;
  }
  return `<div data-row="${row.kind}" ${opens(row.card)} class="row"><span class="tag">${esc(tag)}</span><b class="grow">${esc(row.title)}</b>${figures}</div>`;
}

// The attention list, above the sessions; none without a row.
function attention(rows: AttentionRow[]) {
  if (rows.length === 0) return '';
  return `<section data-part="attention"><h2>Needs attention</h2>${rows.map(attentionRow).join('')}</section>`;
}

function group({ name, count, cards }: HostGroup) {
  const drawn = cards.map((view) => (view.state === 'done' ? folded(view) : card(view))).join('');
  return `<section data-part="group" data-host="${esc(name)}"><h2>${esc(name)} · ${num('count', String(count))}</h2>${drawn}</section>`;
}

export function fleetScreen({ groups, whole }: FleetView): string {
  const header =
    `<header data-part="header"><div class="row"><b class="logo grow">Spyhop</b><span data-part="live" class="live"><i class="dot"></i> live</span></div>` +
    `${whole ? counts(whole) : ''}</header>`;
  return `<main data-screen="fleet">${header}${whole ? burnCard(whole.burn) + attention(whole.attention) : ''}${groups.map(group).join('')}</main>`;
}
