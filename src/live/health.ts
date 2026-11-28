// The Health tab of the live panel, as markup: what the running catch-up is reading and the Orca
// hosts it could not read, as the other range tabs say them; the range's failed model calls, in
// all and by type, Orca host and provider; the retries that recovered; each model's typical and
// slow reply time; its calls cut at the maximum length with their cost; and its thinking tokens,
// each under its title and the line of what it means, with a left-out note of the harnesses a
// figure leaves out. No chart.
// Pure: an answer in, a markup string out.

import { formatCost, formatCount, formatSeconds } from '../core/format.js';
import type { HealthView, Num, RangeAnswer } from '../protocol.ts';
import { esc, num, readNotes, titled } from './html.ts';

// The rows `rows` name, each with its figure `<figure>-<name>` reading `words` of it, as a list
// `list`; none when there are none. `stack`: a list of model names, long ones, whose rows draw
// the name above its figures (`data-stack`, src/live/style.ts).
function listed<T>(list: string, rows: T[], nameOf: (row: T) => string, words: (row: T) => string, stack = false) {
  const body = rows.map((row) => `<div class="row item"><span class="grow">${esc(nameOf(row))}</span>${num(`${list}-${nameOf(row)}`, words(row))}</div>`);
  return `<div data-list="${list}"${stack ? ' data-stack' : ''}>${body.join('')}</div>`;
}

// The failed calls by `rows` (name and count), under `title`.
const failures = (list: string, title: string, meaning: string, rows: HealthView['byType']) => titled(title, meaning, listed(list, rows, (row) => row.name, (row) => formatCount(row.count)));

// The note that says which harnesses `names` leave out of the figure `part`, as `what` they log.
const leftOut = (part: string, names: string[], what: string) =>
  names.length === 0 ? '' : `<p data-part="left-out-${part}" class="muted">This leaves out ${esc(names.join(', '))}, which ${names.length === 1 ? 'logs' : 'log'} ${what}.</p>`;

// A figure's words: its value, or n/a.
const count = (value: Num) => (value === 'n/a' ? 'n/a' : formatCount(value));

// The Health tab of `answer`; '' when it holds no Health tab.
export function healthTab({ health, notRead, progress }: RangeAnswer): string {
  if (!health) return '';
  const total = titled('Failed model calls', 'Model calls that ended in an error, not those the developer interrupted', num('failed', count(health.failed)));
  const retries = titled(
    'Retries that recovered',
    'Model calls that failed and then succeeded when the harness tried again',
    `${num('retries', count(health.retries))}${leftOut('retries', health.retriesLeftOut, 'no retries')}`,
  );
  const replies = titled(
    'Reply times',
    'How long each model took to answer: the typical call (the median) and the slow one (the 95th percentile), over the calls that ended without failure',
    `<div data-list="replies" data-stack>${health.replies
      .map(({ model, typical, slow }) => `<div class="row item"><span class="grow">${esc(model)}</span><span><span class="muted">typical</span> ${num(`typical-${model}`, formatSeconds(typical))} · <span class="muted">slow</span> ${num(`slow-${model}`, formatSeconds(slow))}</span></div>`)
      .join('')}</div>`,
  );
  const cut = titled(
    'Output cut at the maximum length',
    'Model calls whose reply the model had to stop at its maximum length, by model, with what they cost',
    `${listed('cut', health.cut, (row) => row.model, (row) => (row.cost === 'n/a' ? `${formatCount(row.calls)} · n/a` : `${formatCount(row.calls)} · ${formatCost(row.cost)}`), true)}${leftOut('cut', health.cutLeftOut, 'no cost for these calls')}`,
  );
  const thinking = titled(
    'Thinking tokens',
    'The tokens each model spent thinking before it answered',
    `${listed('thinking', health.thinking, (row) => row.model, (row) => count(row.tokens), true)}${leftOut('thinking', health.thinkingLeftOut, 'no thinking tokens')}`,
  );
  return (
    `${readNotes({ notRead, progress })}${total}${retries}` +
    failures('failed-type', 'Failed by type', 'Failed model calls by what went wrong: the network, the login, a missing model, a rate limit, the server, or something else', health.byType) +
    failures('failed-host', 'Failed by Orca host', 'Failed model calls by the Orca host they ran on', health.byHost) +
    failures('failed-provider', 'Failed by provider', 'Failed model calls by the provider of their model', health.byProvider) +
    replies +
    cut +
    thinking
  );
}
