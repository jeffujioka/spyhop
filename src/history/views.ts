// The range tabs' views of the history store (src/history/store.ts): each sums the daily lines of
// a range (`rangeDays`, src/core/days.js).
import { HARNESS_NAMES } from '../agent-cards.ts';
import { rangeDays } from '../core/days.js';
import { AWAY_BANDS, cap, MISS_CAUSES } from '../core/insights.js';
import { FAILURE_TYPES, replyQuantile } from '../core/reply-times.js';
import type { CacheView, HealthView, CostlySession, Num, Range, SpendRow, SpendView } from '../protocol.ts';
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

// The sum of the `figures` named of the daily lines of `lines` that `keyOf` gives one key.
function sumsBy(lines: DailyLine[], keyOf: (line: DailyLine) => string, ...names: string[]) {
  const sums = new Map<string, Record<string, number>>();
  for (const line of lines) {
    const key = keyOf(line);
    const sum = sums.get(key) ?? Object.fromEntries(names.map((name) => [name, 0]));
    for (const name of names) sum[name] += line.figures[name];
    sums.set(key, sum);
  }
  return sums;
}

// `counts` (name -> count) as rows: those over 0, most first, equal counts in their order.
const ranked = (counts: Iterable<[string, number]>) =>
  [...counts]
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

// The failed calls of `lines` (the sum of the figures `names`) by the key `keyOf` gives each line.
function failedBy(lines: DailyLine[], keyOf: (line: DailyLine) => string, names: string[]) {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(keyOf(line), (counts.get(keyOf(line)) ?? 0) + sumOf([line], ...names));
  return ranked([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

// How the Health tab names a type of failure.
const TYPE_NAMES: Record<string, string> = { notFound: 'not found', rateLimit: 'rate limit' };

// The provider of a model: its part before the `/`, n/a for a model that has none.
const providerOf = (model: string) => (model !== 'n/a' && model.includes('/') ? model.slice(0, model.indexOf('/')) : 'n/a');

// Most first, equal values by name; n/a last.
const mostFirst = <T extends { model: string }>(rows: T[], value: (row: T) => Num) => {
  const rank = (row: T) => {
    const v = value(row);
    return v === 'n/a' ? -1 : v;
  };
  return rows.sort((a, b) => rank(b) - rank(a) || a.model.localeCompare(b.model));
};

// The Health tab of `range` as of the epoch ms `now`: see HealthView. `places` names the Orca
// host of a failed call, as the Spend tab does; the store's key of it without.
export function healthView(store: Store, range: Range, now: number, places: Places | null): HealthView {
  const { first, last, lines } = linesOf(store, range, now);
  const failures = FAILURE_TYPES.map((type: string) => `fail${cap(type)}`);
  const models = sumsBy(lines, (line) => line.model, 'calls', 'cutCalls', 'cutCost', 'cutCostNa', 'thinkingCalls', 'thinkingTokens');
  const replies = [...store.replies(first, last)].flatMap(([model, counts]) => {
    const typical = replyQuantile(counts, 0.5);
    return typical === null ? [] : [{ model, typical, slow: replyQuantile(counts, 0.95)! }];
  });
  return {
    failed: sumOf(lines, ...failures),
    byType: ranked(FAILURE_TYPES.map((type: string, i: number) => [TYPE_NAMES[type] ?? type, sumOf(lines, failures[i])] as [string, number])),
    byHost: failedBy(lines, (line) => (places ? places.hostName(line.host) : line.host), failures),
    byProvider: failedBy(lines, (line) => providerOf(line.model), failures),
    retries: sumOf(lines, 'retries'),
    retriesLeftOut: leftOutOf(lines, (line) => line.harness === 'claude'),
    replies: replies.sort((a, b) => a.model.localeCompare(b.model)),
    cut: mostFirst(
      [...models].filter(([, sum]) => sum.cutCalls > 0).map(([model, sum]) => ({ model, calls: sum.cutCalls, cost: sum.cutCostNa > 0 ? ('n/a' as Num) : sum.cutCost })),
      (row) => row.calls,
    ),
    cutLeftOut: leftOutOf(lines, (line) => line.harness === 'claude' && line.figures.cutCostNa > 0),
    thinking: mostFirst(
      [...models].filter(([, sum]) => sum.calls > 0).map(([model, sum]) => ({ model, tokens: sum.thinkingCalls === 0 ? ('n/a' as Num) : sum.thinkingTokens })),
      (row) => row.tokens,
    ),
    thinkingLeftOut: leftOutOf(lines, (line) => line.harness === 'omp'),
  };
}
