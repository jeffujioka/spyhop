// Text put into the live panel's markup, escaped, so that a title or a folder name that holds
// markup is shown as text and never read as tags; the same in an attribute's quoted value. And
// the markup of a figure, which every screen writes alike, of a range tab's titled figure, of a
// part of a cost that says where it comes from, and the rows a list names.

import { formatCost, formatPercent } from '../core/format.js';
import { NA } from '../core/providers/index.js';
import type { Num, RangeAnswer } from '../protocol.ts';

// The rows a list names, the first of its order; the rest are summed as `others`.
export const NAMED_ROWS = 6;

// A row of a list: its name and its values, such as a tool's calls and failed calls.
export type Row = { name: string; values: Num[] };

// The first `named` rows of `rows`, then the rest summed as the row `others`, each of its values
// n/a when one it sums is; `rows` as they are when none is left.
export function topRows(rows: Row[], named: number): Row[] {
  const rest = rows.slice(named);
  if (rest.length === 0) return rows;
  const values = rest[0].values.map((_, i) => rest.reduce<Num>((sum, { values: own }) => (sum === NA || own[i] === NA ? NA : sum + own[i]), 0));
  return [...rows.slice(0, named), { name: 'others', values }];
}

// The part `usd` of a cost (`data-figure` `name`) and the words of where it comes from, as a line
// under the cost; '' when it is 0 (under half a cent) or not known.
export function costPart(name: string, usd: Num, words: string): string {
  return usd === NA || usd < 0.005 ? '' : `<div class="muted">${num(name, formatCost(usd))} ${words}</div>`;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

// The figure `name` (`data-figure`, escaped, so a name taken from data is safe), reading `value`, in the font of figures (`.num`), with the
// classes `classes` beside it when given (a level's colour, a headline's size).
export function num(name: string, value: string, classes = ''): string {
  return `<span class="num${classes ? ` ${classes}` : ''}" data-figure="${esc(name)}">${esc(value)}</span>`;
}

// A figure or chart of the range tabs (`data-part="figure"`, named by its title): its title in
// plain words, under it the one line of what it means, then `body`.
export function titled(title: string, meaning: string, body: string): string {
  return `<section data-part="figure" data-name="${esc(title)}"><b data-title>${esc(title)}</b><p data-meaning class="muted">${esc(meaning)}</p>${body}</section>`;
}

// The attributes that make a block the control whose `data-press` is `kind:` and the encoded id
// `id` (which holds a NUL, `::` and slashes): a block cannot go inside a <button>, so it is a
// button by its role, which the keyboard reaches (`tabindex`) and presses (src/panel.ts). `open`
// opens the session screen of a card, `past` that of a past session.
export function pressable(kind: 'open' | 'past', id: string): string {
  return `role="button" tabindex="0" data-press="${esc(`${kind}:${encodeURIComponent(id)}`)}"`;
}

// What the range tabs say of the history's reading, above their figures: what the running catch-up
// is reading, of a host and harness never read through, and the Orca hosts the last catch-up could
// not read, when there are any.
export function readNotes({ notRead, progress }: Pick<RangeAnswer, 'notRead' | 'progress'>): string {
  const reading = progress
    ? `<p data-part="progress" class="muted">Reading history: ${esc(progress.host)}, ${esc(progress.harness)}, ${formatPercent(progress.share)}</p>`
    : '';
  const unread = notRead.length > 0 ? `<p data-part="not-read" class="muted">Not read this time: ${esc(notRead.join(', '))}. Their figures are those read before.</p>` : '';
  return reading + unread;
}
