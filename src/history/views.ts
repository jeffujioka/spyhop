// The range tabs' views of the history store (src/history/store.ts): each sums the daily lines of
// a range (`rangeDays`, src/core/days.js).
import { HARNESS_NAMES } from '../agent-cards.ts';
import { rangeDays } from '../core/days.js';
import { AWAY_BANDS, cap, MISS_CAUSES } from '../core/insights.js';
import type { CacheView, CostlySession, Num, Range, SpendRow, SpendView } from '../protocol.ts';
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

// The COSTLIEST sessions with a model call in the days `from` to `to`, by their whole cost,
// costliest first, a cost n/a last; a session the store keeps no summary of is left out.
function costliest(store: Store, from: string, to: string, { shown, hostName }: Places): CostlySession[] {
  return store
    .costliestIn(from, to, COSTLIEST)
    .flatMap((id) => store.summary(id) ?? [])
    .map(({ id, title, repo, harness, host, cost }) => ({ id, title, repo, harness: HARNESS_NAMES[harness] ?? harness, host: hostName(host), cost, card: shown.get(id) ?? null }));
}

// The days of `range` as of `now`, as the store keeps them: its `points` (days, or months for a
// Year), `by` (null for Day), `first` and `last`, the first and last day, and the daily `lines` of them.
function linesOf(store: Store, range: Range, now: number) {
  const { from, to, by, points } = rangeDays(range, now);
  // a Year's from and to are months, which span their first to their last day; `to` is always
  // there, though its inferred type allows none
  const [first, last] = by === 'month' ? [`${from}-01`, `${to}-31`] : [from, to!];
  return { by, points: points as string[], first, last, lines: store.dailyLines(first, last) };
}

// The Spend tab of `range` as of the epoch ms `now`: the cost, tokens and model calls of every
// daily line of its days, the cost n/a when a model call logged none, and its cost by each day or
// month of the range, none for Day; its cost by repo, model and harness (named as a card names it),
// its costliest sessions (`places` names their hosts and the Live cards of those a card shows; none
// without `places`),
// the side calls' cost, and the Copilot calls' share of the cost.
export function spendView(store: Store, range: Range, now: number, places: Places | null): SpendView {
  const { by, points, first, last, lines } = linesOf(store, range, now);
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
    costliest: places ? costliest(store, first, last, places) : [],
    sideCost,
    sources: cost === 'n/a' ? { copilot: 'n/a', logged: 'n/a' } : { copilot, logged: cost - copilot },
  };
}

// The names of the harnesses of the daily lines `lines` that `unlogged` holds for, each once, in
// the order of HARNESS_NAMES: those a figure leaves out, which log none of it.
export function leftOutOf(lines: DailyLine[], unlogged: (line: DailyLine) => boolean): string[] {
  const left = new Set(lines.filter(unlogged).map(({ harness }) => HARNESS_NAMES[harness] ?? harness));
  const order = [...new Set(Object.values(HARNESS_NAMES))];
  return [...order.filter((name) => left.has(name)), ...[...left].filter((name) => !order.includes(name))];
}

// The sum of the figures `names` over the daily lines `lines`.
const sumOf = (lines: DailyLine[], ...names: string[]) => lines.reduce((sum, { figures }) => names.reduce((more, name) => more + figures[name], sum), 0);

// The hit rate of the figures of `lines`: what the model calls read from the cache over what they
// read, wrote and sent not cached; n/a without any.
function hitRateOf(lines: DailyLine[]): Num {
  const [read, other] = lines.reduce(([r, o], { figures }) => [r + figures.read, o + figures.write + figures.uncached], [0, 0]);
  return read + other === 0 ? 'n/a' : read / (read + other);
}

// The Cache tab of `range` as of the epoch ms `now`: see CacheView.
export function cacheView(store: Store, range: Range, now: number): CacheView {
  const { by, points, lines } = linesOf(store, range, now);
  // a cause's cost: n/a when a cold start of it has one n/a, none when every one is of a harness
  // that logs none, else the sum of those that have
  const causes = MISS_CAUSES.map((cause: string) => {
    const [cold, tokens, cost, unpriced, costNa] = ['cold', 'coldTokens', 'coldCost', 'coldUnpriced', 'coldCostNa'].map((name) => sumOf(lines, `${name}${cap(cause)}`));
    const priced: Num | null = costNa > 0 ? 'n/a' : cold === unpriced ? null : cost;
    return { cause, cold, tokens, cost: priced };
  });
  const days = new Map<string, DailyLine[]>(points.map((key) => [key, []]));
  for (const line of lines) days.get(by === 'month' ? line.day.slice(0, 7) : line.day)?.push(line);
  const total = (name: string) => sumOf(lines, name);
  const unpricedNames = MISS_CAUSES.map((cause: string) => `coldUnpriced${cap(cause)}`);
  return {
    hitRate: hitRateOf(lines),
    chart: by === null ? null : points.map((key) => ({ key, v: hitRateOf(days.get(key)!) })),
    causes,
    costLeftOut: leftOutOf(lines, (line) => sumOf([line], ...unpricedNames) > 0),
    away: AWAY_BANDS.map((band: string) => ({ band, returns: total(`returns${cap(band)}`), cold: total(`returnsCold${cap(band)}`) })),
    compactions: { idle: total('compactionsIdle'), full: total('compactionsFull'), manual: total('compactionsManual'), inferred: total('compactionsInferred') },
  };
}
