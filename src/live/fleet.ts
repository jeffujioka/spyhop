// The fleet screen of the live panel, as markup: the header, with the number of agents in each
// Orca state once the whole fleet is answered, then each Orca host's group of sessions, a card per
// session whose agent is not done and a folded line per done one, each of which opens its
// session's screen when pressed. Groups only: no Orca project or workspace row. A card whose
// sub-agents are still being read says how many are, beside its own cost; its chips tell how
// close its context is to an autocompaction, its sub-agents and its cache hit rate. Pure: an
// answer in, a markup string out (src/panel.ts draws it).

import { formatAge, formatCost, formatCount, formatPercent, formatTokens, orNa } from '../core/format.js';
import { STATES } from '../fleet.ts';
import type { CardView, FleetAnswer, HostGroup } from '../protocol.ts';
import { contextBar, sparkLine } from './charts.ts';
import { esc, num } from './html.ts';
import { levelOf } from './levels.ts';

// The groups drawn so far, and the whole answer once it is in; the counts come only from it.
export type FleetView = { groups: HostGroup[]; whole: FleetAnswer | null };

// From this percent of the window, as the card writes it (rounded, as its level is taken), a
// card whose tokens left before autocompaction are known warns of them in a chip.
const WARNING_CHIP_AT = 75;

function counts({ counts }: FleetAnswer) {
  const known = STATES.filter((state) => counts[state] !== undefined);
  const items = known.map((state) => `<span data-state="${state}"><i class="dot"></i> ${num(state, String(counts[state]))} ${state}</span>`);
  return `<p data-part="counts">${items.join(' · ')}</p>`;
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

// The card's chips: the tokens left before the harness compacts on its own, from WARNING_CHIP_AT
// percent of the window, when they are known; how many sub-agents run and how many there are, or
// how many there are when the harness does not tell which run, none without a sub-agent; and the
// cache hit rate.
function chips({ context: { percent }, tokensLeft, subAgents, cacheHitRate }: CardView) {
  const warning =
    typeof percent === 'number' && Math.round(percent * 100) >= WARNING_CHIP_AT && typeof tokensLeft === 'number'
      ? `<span data-chip="warning" class="lvl-${levelOf(percent)}"><span class="num">${formatTokens(tokensLeft)}</span> left</span>`
      : '';
  const count = (n: number) => `<span class="num">${formatCount(n)}</span>`;
  const agents = !subAgents
    ? ''
    : subAgents.running === 'n/a'
      ? `<span data-chip="subagents">${count(subAgents.total)} sub-agents</span>`
      : `<span data-chip="subagents">${count(subAgents.running)} sub-agents running</span><span data-chip="subagents">${count(subAgents.total)} in total</span>`;
  return `<div class="row chips">${warning}${agents}<span data-chip="cache">cache <span class="num">${formatPercent(cacheHitRate)}</span></span></div>`;
}

// How many of a session's sub-agent transcripts are read, while some are not: the card and the
// session screen write it where the cost with sub-agents will be.
export function readingNote({ read, total }: NonNullable<CardView['reading']>): string {
  return `reading <span class="num">${read}</span> of <span class="num">${total}</span> sub-agents`;
}

// The attributes that make a card or a folded line the control that opens the session screen of
// `view`: a block cannot go inside a <button>, so it is a button by its role, which the keyboard
// reaches (`tabindex`) and presses (src/panel.ts). Its `data-press` value is encoded, since the
// id holds a NUL, `::` and slashes.
const opens = (view: CardView) => `role="button" tabindex="0" data-press="${esc(`open:${encodeURIComponent(view.id)}`)}"`;

function card(view: CardView) {
  const where = [view.folder, view.branch, view.harness, view.model].filter((part) => part !== null).map(esc).join(' · ');
  return (
    `<article data-part="card" data-state="${esc(view.state)}" ${opens(view)}>` +
    `<div class="row"><i class="dot"></i><b class="title grow">${esc(view.title)}</b>${num('cost', formatCost(view.cost))}</div>` +
    `<div class="row meta"><span class="grow">${where}</span><span>${esc(view.state)} · ${num('since', formatAge(view.stateSinceMs))}</span></div>` +
    `${view.reading ? `<div class="row meta">${readingNote(view.reading)}</div>` : ''}${context(view)}${chips(view)}</article>`
  );
}

// The folded line of a done session: its title, folder, context and cost. The context is the
// percent of the window, or without a window the tokens used.
function folded(view: CardView) {
  const { tokens, window, percent } = view.context;
  const used = window === 'n/a' ? num('tokens', orNa(tokens, formatTokens)) : num('percent', formatPercent(percent));
  return (
    `<div data-part="folded" data-state="${esc(view.state)}" ${opens(view)} class="row"><i class="dot"></i>` +
    `<span class="title grow">${esc(view.title)}</span><span class="muted">${esc(view.folder)}</span>` +
    `${used}${num('cost', formatCost(view.cost))}</div>`
  );
}

function group({ name, count, cards }: HostGroup) {
  const drawn = cards.map((view) => (view.state === 'done' ? folded(view) : card(view))).join('');
  return `<section data-part="group" data-host="${esc(name)}"><h2>${esc(name)} · ${num('count', String(count))}</h2>${drawn}</section>`;
}

export function fleetScreen({ groups, whole }: FleetView): string {
  const header =
    `<header data-part="header"><div class="row"><b class="logo grow">Spyhop</b><span data-part="live" class="live"><i class="dot"></i> live</span></div>` +
    `${whole ? counts(whole) : ''}</header>`;
  return `<main data-screen="fleet">${header}${groups.map(group).join('')}</main>`;
}
