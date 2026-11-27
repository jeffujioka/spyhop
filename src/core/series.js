// Series of a session for the card and the session screen: what the providers' folds keep beside
// their totals, over the whole file, and the per-minute sums of its newest minutes, from which
// the fleet's burn rate card is made. Runtime-neutral and pure, like the providers that use it.
//
// Types, for the readers of this file:
//   Call   = { t, read, write, uncached, output, cost, context }: one model call, at `t` (epoch
//            ms), with the prompt tokens it read from the cache, wrote to it and sent uncached,
//            its output tokens, its cost in USD (null: not logged) and the context after it
//            (null: not logged);
//   Point  = Call & { n }: `n` neighbouring calls as one, their tokens and cost summed, dated and
//            sized by the last of them;
//   Minute = { m, cost, tokens, read, write, uncached }: the calls of the epoch minute `m`
//            (epoch ms / 60000, rounded down), their cost (null once one logged none), their
//            tokens in all, and the prompt tokens they read from the cache, wrote to it and sent
//            uncached.

// The card's spark line draws the context after each of the session's last this many model calls.
export const SPARK_CALLS = 30;

// A session's series of model calls holds at most this many points, however long it runs
// (spec D45).
export const SERIES_POINTS = 120;

// A session keeps the sums of its newest this many minutes, of which the burn rate card sums the
// last 10 and draws the last 60.
export const MINUTES_KEPT = 70;

export const MINUTE_MS = 60_000;

// The epoch minute of the time `t` (epoch ms): the `m` of its Minute.
export const minuteOf = (t) => Math.floor(t / MINUTE_MS);

// Adds the context after one model call to `recent`, the contexts of the latest calls, oldest
// first, and drops the oldest beyond SPARK_CALLS; it changes `recent` and returns it, so a fold's
// state keeps one bounded list however long the session runs.
export function pushRecent(recent, context) {
  recent.push(context);
  if (recent.length > SPARK_CALLS) recent.splice(0, recent.length - SPARK_CALLS);
  return recent;
}

// A sum of costs, unknown once one of them is: a partial sum is never shown as the whole.
export const addCost = (a, b) => (a === null || b === null ? null : a + b);

// Two neighbouring points as one: the sums of their calls, the time of the later one, and its
// context, or the earlier one's when the later call logged none.
function merge(a, b) {
  return {
    t: b.t,
    n: a.n + b.n,
    read: a.read + b.read,
    write: a.write + b.write,
    uncached: a.uncached + b.uncached,
    output: a.output + b.output,
    cost: addCost(a.cost, b.cost),
    context: b.context ?? a.context,
  };
}

// An empty series: `width` is how many calls a point holds at most, doubled each time the series
// is full.
export function newSeries() {
  return { width: 1, points: [] };
}

// Adds a model call to `series`, which it changes and returns: to the newest point while that
// holds fewer than `width` calls, else as a new point. A series of SERIES_POINTS points first
// merges its points in pairs and doubles its width, so it covers the whole session in at most
// SERIES_POINTS points and drops no call.
export function addCall(series, call) {
  const last = series.points.at(-1);
  if (last && last.n < series.width) {
    series.points[series.points.length - 1] = merge(last, { ...call, n: 1 });
    return series;
  }
  if (series.points.length === SERIES_POINTS) {
    const pairs = [];
    for (let i = 0; i < series.points.length; i += 2) pairs.push(merge(series.points[i], series.points[i + 1]));
    series.points = pairs;
    series.width *= 2;
  }
  series.points.push({ ...call, n: 1 });
  return series;
}

// Takes `call`, the latest one added, back out of `series`, which it changes and returns; a
// point left with no call goes. For a response the harness wrote again: the caller adds its
// later version next, which dates the point and gives it its context again.
export function retractLastCall(series, call) {
  const last = series.points.at(-1);
  if (last.n === 1) {
    series.points.pop();
    return series;
  }
  series.points[series.points.length - 1] = {
    ...last,
    n: last.n - 1,
    read: last.read - call.read,
    write: last.write - call.write,
    uncached: last.uncached - call.uncached,
    output: last.output - call.output,
    cost: last.cost === null || call.cost === null ? null : last.cost - call.cost,
  };
  return series;
}

// `points` in at most `room` points, for a chart with room for that many: neighbours merged in
// equal groups, in their order, the last group the smaller one when they do not divide evenly.
export function groupPoints(points, room) {
  const size = Math.ceil(points.length / room);
  const grouped = [];
  for (let i = 0; i < points.length; i += size) grouped.push(points.slice(i, i + size).reduce(merge));
  return grouped;
}

// Adds `call` (a Call with `tokens`, its tokens in all), made at `t`, to the sums of its minute in
// `minutes`, which it changes and returns: the kept minutes, oldest first, the newest at most
// MINUTES_KEPT - 1 minutes after the oldest. A call need not be newer than those added before it
// (a sub-agent's transcript, a response written again), so it goes to its own minute wherever
// that is, and a minute older than the kept ones counts nothing, nor does a call with no time.
// `sign` -1 takes back out a call added before, as `retractLastCall` does in the series.
export function addMinute(minutes, t, call, sign = 1) {
  if (!Number.isFinite(t)) return minutes;
  const m = minuteOf(t);
  const newest = Math.max(m, minutes.at(-1)?.m ?? m);
  if (m <= newest - MINUTES_KEPT) return minutes;
  let i = minutes.length;
  while (i > 0 && minutes[i - 1].m > m) i -= 1;
  const minute = minutes[i - 1];
  if (minute?.m === m) {
    minute.cost = minute.cost === null || call.cost === null ? null : minute.cost + sign * call.cost;
    minute.tokens += sign * call.tokens;
    minute.read += sign * call.read;
    minute.write += sign * call.write;
    minute.uncached += sign * call.uncached;
    return minutes;
  }
  if (sign < 0) return minutes;
  minutes.splice(i, 0, { m, cost: call.cost, tokens: call.tokens, read: call.read, write: call.write, uncached: call.uncached });
  minutes.splice(0, minutes.findIndex((kept) => kept.m > newest - MINUTES_KEPT));
  return minutes;
}

// The sums of the kept `minutes` from the minute `from` to the minute `to`, both counted, as one
// Minute dated `to`; a range with no call sums to 0.
export function minuteSums(minutes, from, to) {
  const sums = { m: to, cost: 0, tokens: 0, read: 0, write: 0, uncached: 0 };
  for (const minute of minutes) {
    if (minute.m < from || minute.m > to) continue;
    sums.cost = addCost(sums.cost, minute.cost);
    sums.tokens += minute.tokens;
    sums.read += minute.read;
    sums.write += minute.write;
    sums.uncached += minute.uncached;
  }
  return sums;
}

// The tally of `key` in `record` (the tools or the models of a session), made by `empty` the
// first time the key is seen.
export function entryOf(record, key, empty) {
  if (!Object.hasOwn(record, key)) record[key] = empty();
  return record[key];
}

// A tool call of the session's own model, `name` its tool and `id` the id its result answers;
// `state` holds `tools`, the calls and failures by tool, and `pending`, a Map of the ids of the
// calls not answered yet to their tools.
export function toolCalled(state, id, name) {
  if (typeof name !== 'string') return;
  entryOf(state.tools, name, () => ({ calls: 0, failed: 0 })).calls += 1;
  if (typeof id === 'string') state.pending.set(id, name);
}

// The result of the tool call `id`; `failed` when the result says the call failed. A result
// whose call is not pending (answered already, or made before the file) counts nothing.
export function toolAnswered(state, id, failed) {
  const name = state.pending.get(id);
  if (name === undefined) return;
  state.pending.delete(id);
  if (failed) state.tools[name].failed += 1;
}

// The `detail` of `readStats` from the series a provider kept over the whole session. A copy,
// since a fold's state goes on folding what the file appends after this read. A session whose
// series is not whole (opencode's, when its tool calls cannot be read) gives `recent` alone.
// `kind` and `model` are those a sub-agent's transcript records of itself (omp: its
// `session_init`), null when it records none; `start` and `end` the times of the file's first
// and last entry, null without one; `minutes` the sums of its newest minutes (`addMinute`).
export function detailOf({ recent, series, marks, cold, tools, models, minutes, kind = null, model = null, firstEntry, lastEntry }) {
  if (!series) return { recent: [...recent] };
  return structuredClone({ recent, points: series.points, marks, cold, tools, models, minutes, kind, model, start: firstEntry ?? null, end: lastEntry ?? null });
}
