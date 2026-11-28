// The Spend tab of the live panel, as markup: the range's cost, tokens and model calls, and for
// Week, Month and Year its cost over time, each under its title and the line of what it means.
// Pure: an answer in, a markup string out.

import { formatCost, formatCount, orNa } from '../core/format.js';
import type { RangeAnswer } from '../protocol.ts';
import { rangeChart } from './charts.ts';
import { num, titled } from './html.ts';

// The Spend tab of `answer`; '' when it holds no Spend tab.
export function spendTab({ range, spend }: RangeAnswer): string {
  if (!spend) return '';
  const { cost, tokens, calls, chart } = spend;
  const figures =
    `<div class="figures">` +
    titled('What the range cost', 'Every harness session on every Orca host, sub-agents included', num('cost', formatCost(cost))) +
    titled('Tokens', 'Prompt and output tokens of every model call, cached ones included', num('tokens', orNa(tokens, formatCount))) +
    titled('Model calls', 'Every call to a model, sub-agents included', num('calls', formatCount(calls))) +
    `</div>`;
  const over = chart
    ? titled('Cost over time', range === 'year' ? 'What each month cost' : 'What each day cost', rangeChart('cost', chart, formatCost))
    : '';
  return `${figures}${over}`;
}
