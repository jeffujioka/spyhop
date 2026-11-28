// The daily lines of the model calls a fold reads: their figures summed by the local day each
// call ended and its model, until the caller takes them (src/core/days.js).

import { dayOf } from './days.js';

// The figures of a daily line. `cost` sums the logged costs; `costNa` counts the calls that
// logged none.
export const LINE_FIGURES = ['calls', 'tokens', 'uncached', 'read', 'write', 'output', 'cost', 'costNa'];

// The open buckets: `day\nmodel` -> `{ day, model, figures }`.
export const newInsights = () => ({ open: new Map() });

// Adds the model call `call` (`end` epoch ms, `model`, its token counts and `cost`, null when
// none was logged) to the bucket of its day and model.
export function noteCall(ins, call) {
  const day = dayOf(call.end);
  const key = `${day}\n${call.model}`;
  let line = ins.open.get(key);
  if (!line) {
    line = { day, model: call.model, figures: Object.fromEntries(LINE_FIGURES.map((name) => [name, 0])) };
    ins.open.set(key, line);
  }
  const { figures } = line;
  figures.calls += 1;
  for (const name of ['tokens', 'uncached', 'read', 'write', 'output']) figures[name] += call[name];
  if (call.cost === null) figures.costNa += 1;
  else figures.cost += call.cost;
}

// The lines noted since the last take, which it empties.
export function takeLines(ins) {
  const lines = [...ins.open.values()];
  ins.open.clear();
  return lines;
}
