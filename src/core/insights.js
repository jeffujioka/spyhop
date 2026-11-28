// The daily lines of the model calls a fold reads: their figures summed by the local day each
// call ended and its model, until the caller takes them (src/core/days.js).

import { dayOf } from './days.js';

// The figures of a daily line. `cost` sums the costs, side calls' included; `costNa` counts the
// calls that have none. `sideCost` and `sideTokens` are the side calls' share of the cost and
// tokens, which count as no model call; `copilotCost` is the Copilot calls' share of the cost.
export const LINE_FIGURES = ['calls', 'tokens', 'uncached', 'read', 'write', 'output', 'cost', 'costNa', 'sideCost', 'sideTokens', 'copilotCost'];

// The open buckets: `day\nmodel` -> `{ day, model, figures }`.
export const newInsights = () => ({ open: new Map() });

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
// -1 takes back a call noted before, for a fold whose later entry replaces it.
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
