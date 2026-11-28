// The range tabs' views of the history store (src/history/store.ts): each sums the daily lines of
// a range (`rangeDays`, src/core/days.js).
import { HARNESS_NAMES } from '../agent-cards.ts';
import { rangeDays } from '../core/days.js';
import type { Num, Range, SpendRow, SpendView } from '../protocol.ts';
import type { DailyLine, Store } from './store.ts';

// `before` with the cost of the daily line figures `figures` added: n/a once a model call it sums
// logged none.
const addCost = (before: Num, figures: DailyLine['figures']): Num => (before === 'n/a' || figures.costNa > 0 ? 'n/a' : before + figures.cost);

// The cost of `lines` by the key `keyOf` gives each, costliest first, a cost n/a last.
function costBy(lines: DailyLine[], keyOf: (line: DailyLine) => string): SpendRow[] {
  const costs = new Map<string, Num>();
  for (const line of lines) {
    const key = keyOf(line);
    costs.set(key, addCost(costs.get(key) ?? 0, line.figures));
  }
  const rank = (cost: Num) => (cost === 'n/a' ? -Infinity : cost);
  return [...costs].map(([name, cost]) => ({ name, cost })).sort((a, b) => rank(b.cost) - rank(a.cost));
}

// The Spend tab of `range` as of the epoch ms `now`: the cost, tokens and model calls of every
// daily line of its days, the cost n/a when a model call logged none, and its cost by each day or
// month of the range, none for Day; its cost by repo, model and harness (named as a card names it),
// the side calls' cost, and the Copilot calls' share of the cost.
export function spendView(store: Store, range: Range, now: number): SpendView {
  const { from, to, by, points } = rangeDays(range, now);
  // a Year's from and to are months, which span their first to their last day; `to` is always
  // there, though its inferred type allows none
  const lines = by === 'month' ? store.dailyLines(`${from}-01`, `${to}-31`) : store.dailyLines(from, to!);
  const costs = new Map<string, Num>(points.map((key: string) => [key, 0]));
  let tokens = 0;
  let calls = 0;
  let sideCost = 0;
  let copilot = 0;
  let cost: Num = 0;
  for (const { day, figures } of lines) {
    tokens += figures.tokens;
    calls += figures.calls;
    sideCost += figures.sideCost;
    copilot += figures.copilotCost;
    cost = addCost(cost, figures);
    const key = by === 'month' ? day.slice(0, 7) : day;
    costs.set(key, addCost(costs.get(key) ?? 0, figures));
  }
  return {
    cost,
    tokens,
    calls,
    chart: by === null ? null : points.map((key: string) => ({ key, v: costs.get(key)! })),
    byRepo: costBy(lines, (line) => line.repo),
    byModel: costBy(lines, (line) => line.model),
    byHarness: costBy(lines, (line) => HARNESS_NAMES[line.harness] ?? line.harness),
    sideCost,
    sources: cost === 'n/a' ? { copilot: 'n/a', logged: 'n/a' } : { copilot, logged: cost - copilot },
  };
}
