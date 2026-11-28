// The range tabs' views of the history store (src/history/store.ts): each sums the daily lines of
// a range (`rangeDays`, src/core/days.js).
import { rangeDays } from '../core/days.js';
import type { Range, SpendView } from '../protocol.ts';
import type { Store } from './store.ts';

// The Spend tab of `range` as of the epoch ms `now`: the cost, tokens and model calls of every
// daily line of its days, the cost n/a when a model call logged none, and its cost by each day or
// month of the range, none for Day.
export function spendView(store: Store, range: Range, now: number): SpendView {
  const { from, to, by, points } = rangeDays(range, now);
  // a Year's from and to are months, which span their first to their last day; `to` is always
  // there, though its inferred type allows none
  const lines = by === 'month' ? store.dailyLines(`${from}-01`, `${to}-31`) : store.dailyLines(from, to!);
  const costs = new Map<string, number | 'n/a'>(points.map((key: string) => [key, 0]));
  let tokens = 0;
  let calls = 0;
  for (const { day, figures } of lines) {
    tokens += figures.tokens;
    calls += figures.calls;
    const key = by === 'month' ? day.slice(0, 7) : day;
    const before = costs.get(key) ?? 0;
    costs.set(key, before === 'n/a' || figures.costNa > 0 ? 'n/a' : before + figures.cost);
  }
  const cost = lines.some(({ figures }) => figures.costNa > 0) ? 'n/a' : lines.reduce((sum, { figures }) => sum + figures.cost, 0);
  return { cost, tokens, calls, chart: by === null ? null : points.map((key: string) => ({ key, v: costs.get(key)! })) };
}
