// The range tabs' views of the history store (src/history/store.ts): each sums the daily lines of
// a range (`rangeDays`, src/core/days.js).
import { HARNESS_NAMES } from '../agent-cards.ts';
import { rangeDays } from '../core/days.js';
import type { CostlySession, Num, Range, SpendRow, SpendView } from '../protocol.ts';
import type { DailyLine, Store } from './store.ts';

// How many of the costliest sessions the Spend tab lists.
export const COSTLIEST = 10;

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

// What the costliest sessions need beyond the store: `shown`, the id of each session a Live card
// shows -> the card's id, and `hostName`, the name of the Orca host of a store key.
export type Places = { shown: Map<string, string>; hostName(key: string): string };
const NO_PLACES: Places = { shown: new Map(), hostName: (key) => key };

// The COSTLIEST sessions with a model call in the days `from` to `to`, by their whole cost,
// costliest first, a cost n/a last; a session the store keeps no summary of is left out.
function costliest(store: Store, from: string, to: string, { shown, hostName }: Places): CostlySession[] {
  const rank = (cost: Num) => (cost === 'n/a' ? -Infinity : cost);
  return store
    .sessionsOf(from, to)
    .flatMap((id) => store.summary(id) ?? [])
    .sort((a, b) => rank(b.cost) - rank(a.cost))
    .slice(0, COSTLIEST)
    .map(({ id, title, repo, harness, host, cost }) => ({ id, title, repo, harness: HARNESS_NAMES[harness] ?? harness, host: hostName(host), cost, card: shown.get(id) ?? null }));
}

// The Spend tab of `range` as of the epoch ms `now`: the cost, tokens and model calls of every
// daily line of its days, the cost n/a when a model call logged none, and its cost by each day or
// month of the range, none for Day; its cost by repo, model and harness (named as a card names it),
// its costliest sessions (`places` names their hosts and the Live cards of those a card shows),
// the side calls' cost, and the Copilot calls' share of the cost.
export function spendView(store: Store, range: Range, now: number, places: Places = NO_PLACES): SpendView {
  const { from, to, by, points } = rangeDays(range, now);
  // a Year's from and to are months, which span their first to their last day; `to` is always
  // there, though its inferred type allows none
  const [first, last] = by === 'month' ? [`${from}-01`, `${to}-31`] : [from, to!];
  const lines = store.dailyLines(first, last);
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
    costliest: costliest(store, first, last, places),
    sideCost,
    sources: cost === 'n/a' ? { copilot: 'n/a', logged: 'n/a' } : { copilot, logged: cost - copilot },
  };
}
