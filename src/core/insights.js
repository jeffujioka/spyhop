// The daily lines of the model calls a fold reads: their figures summed by the local day each
// call ended and its model, until the caller takes them (src/core/days.js); the Trace lanes of
// the session it reads (src/core/trace.js); and what its summary needs: its title, cost, tokens,
// models and the statuses its harness logged of the sub-agents it started. No text of a prompt,
// a reply, a task or a tool call is kept.

import { dayOf } from './days.js';
import { addSpan, newLane, pruneGaps } from './trace.js';

// The figures of a daily line. `cost` sums the costs, side calls' included; `costNa` counts the
// calls that have none. `sideCost` and `sideTokens` are the side calls' share of the cost and
// tokens, which count as no model call; `copilotCost` is the Copilot calls' share of the cost.
//
// The Cache tab's figures: for each miss cause (MISS_CAUSES), `cold<Cause>` the cold starts that
// have it, `coldTokens<Cause>` the tokens they wrote to the cache again, `coldCost<Cause>` the
// cost of those writes, `coldUnpriced<Cause>` the cold starts whose harness logs no such cost and
// `coldCostNa<Cause>` those whose cost is n/a: a Copilot call the price table cannot price;
// for each time away (AWAY_BANDS), `returns<Band>` the returns after a turn end and
// `returnsCold<Band>` those whose next model call was a cold start; and the compactions by kind,
// `compactionsIdle`, `compactionsFull` and `compactionsManual`, of which `compactionsInferred`
// were told apart by inference (see noteCompaction).
export const MISS_CAUSES = ['expired', 'model', 'thinking', 'compaction', 'other'];
export const AWAY_BANDS = ['under5', 'to60', 'over60'];
export const cap = (word) => word[0].toUpperCase() + word.slice(1);
// The figures that are money, USD, which a store keeps as reals.
export const MONEY_FIGURES = ['cost', ...MISS_CAUSES.map((cause) => `coldCost${cap(cause)}`)];
export const LINE_FIGURES = [
  'calls', 'tokens', 'uncached', 'read', 'write', 'output', 'cost', 'costNa', 'sideCost', 'sideTokens', 'copilotCost',
  ...MISS_CAUSES.flatMap((cause) => ['cold', 'coldTokens', 'coldCost', 'coldUnpriced', 'coldCostNa'].map((figure) => `${figure}${cap(cause)}`)),
  ...AWAY_BANDS.flatMap((band) => [`returns${cap(band)}`, `returnsCold${cap(band)}`]),
  'compactionsIdle', 'compactionsFull', 'compactionsManual', 'compactionsInferred',
];

// A time away of 5 minutes or more is past the first band, one over an hour in the last; a call
// 5 minutes or more after the one before makes an omp compaction idle.
const FIVE_MINUTES = 5 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// The open buckets: `day\nmodel` -> `{ day, model, figures }`. The Trace lanes: `thinking`, the
// session's model calls; `tools`, its tool calls; `busy`, both but the tool calls that start or
// await sub-agents; `developer`, from a reply that ends a turn to the developer's next prompt.
// `firstMs` and `lastMs`: the first and the last time noted (see noteEntry), null before one;
// `turnEnd`: the end of the turn the session waits on the developer since, null when it does not;
// `started`: the tool calls started and not ended yet, id -> `{ at, name }`, the time it started
// (epoch ms) and its tool's name. `title`: the newest title the harness logged, null before one;
// `cost`, `costNa` and `tokens`: the sums of all the calls noted, as the daily lines sum them;
// `models`: each model a call noted, -> true; `statuses`: the status of each sub-agent, by its key
// (see noteStatus). The Cache tab's: `last`, by thread (the session a call is of; '' where a fold
// reads one), the newest model call noted (`{ end, model, thinking, lifetimeMs, effects,
// restore }`: when it ended, its model, thinking level and cache lifetime, the figures it added
// to its line and what to put back to take it back out); `compacted`, the threads a compaction
// was noted in since their last call; `returned`, the return a prompt made, which the next call
// of its thread counts (`{ gap, thread }`); `unplaced`, by thread, the compaction figures noted
// before any call of it, which its next call's line takes.
export const newInsights = () => ({
  open: new Map(),
  lanes: { thinking: newLane(), tools: newLane(), busy: newLane(), developer: newLane() },
  firstMs: null,
  lastMs: null,
  turnEnd: null,
  started: new Map(),
  title: null,
  cost: 0,
  costNa: 0,
  tokens: 0,
  models: {},
  statuses: new Map(),
  last: {},
  compacted: {},
  returned: null,
  unplaced: {},
});

// Widens the time `ins` noted to `start` and `end`.
function seen(ins, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;
  ins.firstMs = ins.firstMs === null ? start : Math.min(ins.firstMs, start);
  ins.lastMs = ins.lastMs === null ? end : Math.max(ins.lastMs, end);
}

// An entry of the session at `t` (epoch ms): the Trace's axis runs from the first to the last.
export function noteEntry(ins, t) {
  seen(ins, t, t);
}

// The model a daily line names: `<provider>/<model>` when the harness logs the provider.
export const modelKey = (provider, model) => (typeof provider === 'string' && provider ? `${provider}/${model}` : model);

// The bucket of the day of `t` (epoch ms) and of `model`, opened when it is not.
function lineOf(ins, t, model) {
  const day = dayOf(t);
  const key = `${day}\n${model}`;
  let line = ins.open.get(key);
  if (!line) {
    line = { day, model, figures: Object.fromEntries(LINE_FIGURES.map((name) => [name, 0])) };
    ins.open.set(key, line);
  }
  return line;
}

// The miss cause of the cold start `call` after `before` (the newest call of its thread, null when
// none): the first that holds. A harness that logs no cache lifetime has no call that expired; a
// call that logs none after one that did keeps that one's (a cache read renews the cache). The time
// away runs from the end of the call before to the start of this one, else (a call whose start the
// harness logs not) to its end, so a slow call without a start may read as expired.
function missCause(ins, call, before, thread) {
  if (before && before.lifetimeMs !== null && (call.start ?? call.end) - before.end > before.lifetimeMs) return 'expired';
  if (before && before.model !== call.model) return 'model';
  if (before && before.thinking !== null && call.thinking !== null && before.thinking !== call.thinking) return 'thinking';
  if (ins.compacted[thread]) return 'compaction';
  return 'other';
}

// The figures the call `call` of `thread` adds besides its tokens and cost: `[name, amount]`.
function cacheEffects(ins, call, before, thread) {
  const effects = [];
  if (call.cold === true) {
    const cause = cap(missCause(ins, call, before, thread));
    effects.push([`cold${cause}`, 1], [`coldTokens${cause}`, call.write]);
    if (typeof call.writeCost === 'number') effects.push([`coldCost${cause}`, call.writeCost]);
    else effects.push([call.copilot ? `coldCostNa${cause}` : `coldUnpriced${cause}`, 1]);
  }
  if (ins.returned && ins.returned.thread === thread) {
    const { gap } = ins.returned;
    const band = cap(gap < FIVE_MINUTES ? 'under5' : gap <= HOUR ? 'to60' : 'over60');
    effects.push([`returns${band}`, 1]);
    if (call.cold === true) effects.push([`returnsCold${band}`, 1]);
  }
  for (const name of ins.unplaced[thread] ?? []) effects.push([name, 1]);
  return effects;
}

// Adds the model call `call` (`end` epoch ms, `model`, its token counts and `cost`, null when it
// has none; `side`: a side call, `copilot`: a call through Copilot) to the bucket of its day and
// model. A side call adds its tokens and cost, but no model call nor its prompt's tokens. `sign`
// -1 takes back a call noted before, for a fold whose later entry replaces it: the call that
// replaces it is noted again, and its span merges with the one noted before. A call with a
// `start` (epoch ms), not a side call, also runs then (noteThinking); one without (a sub-agent's
// call in its root session's rows) runs in no lane, and the reader of a call whose day is not its
// end notes that call's lane span separately through noteThinking.
export function noteCall(ins, call, sign = 1) {
  const { figures } = lineOf(ins, call.end, call.model);
  figures.tokens += sign * call.tokens;
  ins.tokens += sign * call.tokens;
  ins.models[call.model] = true;
  if (call.side) figures.sideTokens += sign * call.tokens;
  else {
    figures.calls += sign;
    for (const name of ['uncached', 'read', 'write', 'output']) figures[name] += sign * call[name];
  }
  if (call.cost === null) {
    figures.costNa += sign;
    ins.costNa += sign;
  } else {
    figures.cost += sign * call.cost;
    ins.cost += sign * call.cost;
    if (call.side) figures.sideCost += sign * call.cost;
    if (call.copilot) figures.copilotCost += sign * call.cost;
  }
  // a side call and a compaction's summary call (`summary`, written by the compaction agent with its
  // own model) are no cold start and not the call before the next one
  if (call.side || call.summary) return;
  const thread = call.thread ?? '';
  if (sign > 0) {
    const before = ins.last[thread] ?? null;
    const effects = cacheEffects(ins, call, before, thread);
    for (const [name, amount] of effects) figures[name] += amount;
    const restore = { last: before && { ...before, restore: null }, compacted: ins.compacted[thread] === true, returned: ins.returned, unplaced: ins.unplaced[thread] };
    ins.last[thread] = { end: call.end, model: call.model, thinking: call.thinking ?? null, lifetimeMs: call.lifetimeMs ?? before?.lifetimeMs ?? null, effects, restore };
    delete ins.compacted[thread];
    if (ins.returned?.thread === thread) ins.returned = null;
    delete ins.unplaced[thread];
    noteThinking(ins, call.start, call.end);
  } else {
    // only the newest call of its thread can be taken back
    const newest = ins.last[thread];
    if (!newest?.restore) return;
    for (const [name, amount] of newest.effects) figures[name] -= amount;
    ins.returned = newest.restore.returned;
    if (newest.restore.unplaced) ins.unplaced[thread] = newest.restore.unplaced;
    if (newest.restore.compacted) ins.compacted[thread] = true;
    if (newest.restore.last) ins.last[thread] = newest.restore.last;
    else delete ins.last[thread];
  }
}

// A compaction at `t` (epoch ms) of the session `thread` ('' where a fold reads one), from `before`
// tokens of context (null when unknown): of the kind `kind`, `idle`, `full` or `manual`, as the
// harness logs it, or, with none (null), as inferred: `full` when `before` reaches `autoAt` (the
// tokens at which the harness compacts on its own, null when unknown),
// else `idle` when the call before ended 5 minutes or more earlier, else `manual`; an inferred
// one is also counted in `compactionsInferred`. The next call of the thread has it as a miss
// cause. It counts in the line of the day of `t` and the model of the call before, else of the
// next call.
export function noteCompaction(ins, { t, kind, before, autoAt = null, thread = '' }) {
  const prior = ins.last[thread];
  ins.compacted[thread] = true;
  // a compaction with no readable time is none to count
  if (!Number.isFinite(t)) return;
  const reached = Number.isFinite(before) && Number.isFinite(autoAt) && before >= autoAt;
  const own = kind ?? (reached ? 'full' : prior && t - prior.end >= FIVE_MINUTES ? 'idle' : 'manual');
  const names = [`compactions${cap(own)}`, ...(kind === null ? ['compactionsInferred'] : [])];
  if (!prior) {
    (ins.unplaced[thread] ??= []).push(...names);
    return;
  }
  const { figures } = lineOf(ins, t, prior.model);
  for (const name of names) figures[name] += 1;
}

// A model call of the session from `start` to `end` (epoch ms): it runs in the thinking and the
// busy lane, and the session no longer waits on the developer. One with no `start` is none.
export function noteThinking(ins, start, end) {
  if (!Number.isFinite(start)) return;
  addSpan(ins.lanes.thinking, start, end);
  addSpan(ins.lanes.busy, start, end);
  seen(ins, start, end);
  ins.turnEnd = null;
}

// Adds the tool call from `start` to `end` (epoch ms) to the tools lane, and to the busy lane
// unless it `startsSubAgents` (SUBAGENT_TOOLS of src/core/trace.js).
export function noteTool(ins, start, end, startsSubAgents) {
  addSpan(ins.lanes.tools, start, end);
  if (!startsSubAgents) addSpan(ins.lanes.busy, start, end);
  seen(ins, start, end);
}

// The tool call `id` of the tool `name` started at `at` (epoch ms); a start noted before stands.
export function noteToolStart(ins, id, at, name) {
  if (typeof id === 'string' && !ins.started.has(id)) ins.started.set(id, { at, name });
}

// No span the reader notes later starts before `horizon` (epoch ms), but for the tool calls
// started and not ended yet and the wait on the developer since the turn ended: the lanes drop
// the joined gaps none of them can reach (pruneGaps). A horizon that is no time is none.
export function noteHorizon(ins, horizon) {
  if (!Number.isFinite(horizon)) return;
  let from = horizon;
  for (const { at } of ins.started.values()) if (Number.isFinite(at)) from = Math.min(from, at);
  for (const lane of [ins.lanes.thinking, ins.lanes.tools, ins.lanes.busy]) pruneGaps(lane, from);
  pruneGaps(ins.lanes.developer, Math.min(from, ins.turnEnd ?? from));
}

// The tool call `id` noted started ended at `end` (epoch ms): noted as a tool call (noteTool) that
// starts sub-agents when its tool is one of `subAgentTools`. One not noted started is in no lane.
export function noteToolEnd(ins, id, end, subAgentTools) {
  const started = ins.started.get(id);
  if (!started) return;
  ins.started.delete(id);
  noteTool(ins, started.at, end, subAgentTools.includes(started.name));
}

// The reply that ends a turn, at `t` (epoch ms): the session waits on the developer from then.
export function noteTurnEnd(ins, t) {
  ins.turnEnd = t;
  seen(ins, t, t);
}

// The developer's prompt at `t` (epoch ms), of the session `thread` ('' where a fold reads one):
// the wait since the turn ended, if it did, is over, and is a return, which the next model call of
// the thread counts by the time away.
export function notePrompt(ins, t, thread = '') {
  if (ins.turnEnd !== null) {
    addSpan(ins.lanes.developer, ins.turnEnd, t);
    ins.returned = { gap: t - ins.turnEnd, thread };
  }
  ins.turnEnd = null;
  seen(ins, t, t);
}

// Adds `usd` to the cost of `model` on the day of `t` (epoch ms), as no model call: a cost a
// harness logs apart from its calls.
export function noteCost(ins, t, model, usd) {
  lineOf(ins, t, model).figures.cost += usd;
  ins.cost += usd;
}

// The harness logged `status` for the sub-agent `key` (its name or id where the harness keys its
// sub-agents); the newest stands. A key or status that is no string is none.
export function noteStatus(ins, key, status) {
  if (typeof key === 'string' && typeof status === 'string') ins.statuses.set(key, status);
}

// The lines noted since the last take, which it empties.
export function takeLines(ins) {
  const lines = [...ins.open.values()];
  ins.open.clear();
  return lines;
}
