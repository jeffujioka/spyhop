// The daily lines of the model calls a fold reads: their figures summed by the local day each
// call ended and its model, until the caller takes them (src/core/days.js); and the Trace lanes of
// the session it reads (src/core/trace.js).

import { dayOf } from './days.js';
import { addSpan, newLane } from './trace.js';

// The figures of a daily line. `cost` sums the costs, side calls' included; `costNa` counts the
// calls that have none. `sideCost` and `sideTokens` are the side calls' share of the cost and
// tokens, which count as no model call; `copilotCost` is the Copilot calls' share of the cost.
export const LINE_FIGURES = ['calls', 'tokens', 'uncached', 'read', 'write', 'output', 'cost', 'costNa', 'sideCost', 'sideTokens', 'copilotCost'];

// The open buckets: `day\nmodel` -> `{ day, model, figures }`. The Trace lanes: `thinking`, the
// session's model calls; `tools`, its tool calls; `busy`, both but the tool calls that start or
// await sub-agents; `developer`, from a reply that ends a turn to the developer's next prompt.
// `firstMs` and `lastMs`: the first and the last time noted, null before one; `turnEnd`: the end
// of the turn the session waits on the developer since, null when it does not; `started`: the tool
// calls started and not ended yet, id -> `{ at, name }`, the time it started (epoch ms) and its
// tool's name.
export const newInsights = () => ({
  open: new Map(),
  lanes: { thinking: newLane(), tools: newLane(), busy: newLane(), developer: newLane() },
  firstMs: null,
  lastMs: null,
  turnEnd: null,
  started: new Map(),
});

// Widens the time `ins` noted to `start` and `end`.
function seen(ins, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;
  ins.firstMs = ins.firstMs === null ? start : Math.min(ins.firstMs, start);
  ins.lastMs = ins.lastMs === null ? end : Math.max(ins.lastMs, end);
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

// Adds the model call `call` (`end` epoch ms, `model`, its token counts and `cost`, null when it
// has none; `side`: a side call, `copilot`: a call through Copilot) to the bucket of its day and
// model. A side call adds its tokens and cost, but no model call nor its prompt's tokens. `sign`
// -1 takes back a call noted before, for a fold whose later entry replaces it: the call that
// replaces it is noted again, and its span merges with the one noted before. A call with a
// `start` (epoch ms), not a side call, also runs in the thinking and the busy lane, and the
// session no longer waits on the developer; one without (a sub-agent's call in its root session's
// rows) runs in no lane.
export function noteCall(ins, call, sign = 1) {
  const { figures } = lineOf(ins, call.end, call.model);
  figures.tokens += sign * call.tokens;
  if (call.side) figures.sideTokens += sign * call.tokens;
  else {
    figures.calls += sign;
    for (const name of ['uncached', 'read', 'write', 'output']) figures[name] += sign * call[name];
  }
  if (call.cost === null) figures.costNa += sign;
  else {
    figures.cost += sign * call.cost;
    if (call.side) figures.sideCost += sign * call.cost;
    if (call.copilot) figures.copilotCost += sign * call.cost;
  }
  if (sign < 0 || call.side || !Number.isFinite(call.start)) return;
  addSpan(ins.lanes.thinking, call.start, call.end);
  addSpan(ins.lanes.busy, call.start, call.end);
  seen(ins, call.start, call.end);
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

// The developer's prompt at `t` (epoch ms): the wait since the turn ended, if it did, is over.
export function notePrompt(ins, t) {
  if (ins.turnEnd !== null) addSpan(ins.lanes.developer, ins.turnEnd, t);
  ins.turnEnd = null;
  seen(ins, t, t);
}

// Adds `usd` to the cost of `model` on the day of `t` (epoch ms), as no model call: a cost a
// harness logs apart from its calls.
export function noteCost(ins, t, model, usd) {
  lineOf(ins, t, model).figures.cost += usd;
}

// The lines noted since the last take, which it empties.
export function takeLines(ins) {
  const lines = [...ins.open.values()];
  ins.open.clear();
  return lines;
}
