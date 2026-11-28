// The Cache tab of the live panel, as markup: what the running catch-up is reading and the Orca
// hosts it could not read, as the Spend tab says them; the range's cache hit rate and, for Week,
// Month and Year, over time; its cold starts by miss cause with the tokens they wrote again and
// their cost, with a note of the harnesses that log no such cost; its returns by time away, how
// many found the cache cold; its compactions by kind; and a hint per cause other than `other` that
// has cold starts, each under its title and the line of what it means.
// Pure: an answer in, a markup string out.

import { formatCost, formatCount, formatPercent } from '../core/format.js';
import type { CacheView, Num, RangeAnswer } from '../protocol.ts';
import { rangeChart } from './charts.ts';
import { esc, num, readNotes, titled } from './html.ts';

// Each miss cause: how a row names it, and what happened, as a hint says it after the cold starts
// it caused.
const CAUSES: Record<string, { name: string; what: string }> = {
  expired: { name: 'Back after the cache expired', what: 'after the cache expired' },
  model: { name: 'Model switched', what: 'after a switch of model' },
  thinking: { name: 'Thinking level changed', what: 'after a change of thinking level' },
  compaction: { name: 'After a compaction', what: 'after a compaction' },
  other: { name: 'Other', what: 'for no cause spyhop can tell' },
};

const BANDS: Record<string, string> = { under5: 'Under 5 minutes', to60: '5 to 60 minutes', over60: 'Over 60 minutes' };

// `count` of a thing: "1 return", "2 returns".
const counted = (count: Num, one: string) => (count === 1 ? `1 ${one}` : `${formatCount(count)} ${one}s`);

// The cold starts of the miss causes, a row each: their count, the tokens they wrote again and
// their cost, none when no cold start of the cause has one; and the cost's left-out note.
function coldStarts({ causes, costLeftOut }: CacheView) {
  const rows = causes.map(({ cause, cold, tokens, cost }) => {
    const words = cold === 'n/a' ? 'n/a' : [formatCount(cold), formatCount(tokens), ...(cost === null ? [] : [formatCost(cost)])].join(' · ');
    return `<div data-cause="${cause}" class="row item"><span class="grow">${esc(CAUSES[cause]?.name ?? cause)}</span>${num(`cold-${cause}`, words)}</div>`;
  });
  const note = costLeftOut.length > 0 ? `<p data-part="left-out" class="muted">The cost leaves out ${esc(costLeftOut.join(', '))}, which log no cost for these cache writes.</p>` : '';
  return titled('Cold starts', 'Model calls that wrote the prompt to the cache again instead of reading it, by what caused them, with the tokens written and what they cost', `<div data-list="cold">${rows.join('')}</div>${note}`);
}

// The returns by their time away, a row each.
function timeAway({ away }: CacheView) {
  const rows = away.map(({ band, returns, cold }) => {
    const words = returns === 'n/a' || cold === 'n/a' ? 'n/a' : `${counted(returns, 'return')} · ${formatCount(cold)} cold`;
    return `<div class="row item"><span class="grow">${BANDS[band] ?? esc(band)}</span>${num(`away-${band}`, words)}</div>`;
  });
  return titled('Time away', 'How long the developer was away before returning to a session, and how many found its prompt cache cold', `<div data-list="away">${rows.join('')}</div>`);
}

// The compactions by kind, the kinds there are, marked inferred when any was told apart by inference.
function compactionKinds({ compactions: { idle, full, manual, inferred } }: CacheView) {
  const kinds = ([['context full', full], ['idle', idle], ['manual', manual]] as const).filter(([, count]) => count !== 0);
  const words = [full, idle, manual].includes('n/a') ? 'n/a' : kinds.length > 0 ? kinds.map(([kind, count]) => `${formatCount(count)} ${kind}`).join(' · ') : 'none';
  const mark = typeof inferred === 'number' && inferred > 0 ? ' <span class="muted" data-part="inferred">inferred</span>' : '';
  return titled('Compactions', 'How often a session was compacted: when its context was full, when it sat idle, or when the developer asked', `<div class="row item">${num('compactions', words)}${mark}</div>`);
}

// A hint per cause other than `other` with cold starts: what happened, how many cold starts it
// caused and that avoiding it would have saved up to their cost, an estimate.
function hints({ causes }: CacheView) {
  const found = causes.flatMap(({ cause, cold, cost }) => {
    if (cause === 'other' || typeof cold !== 'number' || cold === 0) return [];
    const saved = cost === null || cost === 'n/a' ? '' : `: avoiding them would have saved up to ${formatCost(cost)} <span data-estimate>estimate</span>`;
    return [`<p data-part="hint" data-cause="${cause}">${counted(cold, 'cold start')} ${esc(CAUSES[cause]?.what ?? cause)}${saved}</p>`];
  });
  return found.length === 0 ? '' : titled('Hints', 'What caused cold starts that could have been avoided, and what avoiding them would have saved', found.join(''));
}

// The Cache tab of `answer`; '' when it holds no Cache tab.
export function cacheTab({ range, cache, notRead, progress }: RangeAnswer): string {
  if (!cache) return '';
  const rate = titled('Cache hit rate', 'The share of prompt tokens read from the prompt cache instead of written to it or sent not cached', num('hitRate', formatPercent(cache.hitRate)));
  const over = cache.chart
    ? titled('Cache hit rate over time', range === 'year' ? 'The cache hit rate of each month' : 'The cache hit rate of each day', rangeChart('hitRate', cache.chart, formatPercent, formatPercent))
    : '';
  return `${readNotes({ notRead, progress })}<div class="figures">${rate}</div>${over}${coldStarts(cache)}${timeAway(cache)}${compactionKinds(cache)}${hints(cache)}`;
}
