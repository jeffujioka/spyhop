// Copied from herdr-session-stats (src/providers/jsonl.js).
//
// Helpers shared by the providers that read a jsonl session.

import { isNumber } from './shared.js';

// Entries of a jsonl text, one per line that is whole JSON and an object; any other line (a
// window can start mid-line, a file can end mid-write) carries no figure and is skipped.
export function parseEntries(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object') entries.push(entry);
    } catch {
      // partial or damaged line: carries no figure
    }
  }
  return entries;
}

// A running sum that tells "no value seen" from "values that add to 0": `sum` is undefined
// until a number is added, so a figure no entry carries reads n/a, never 0. `add` takes
// `sign` -1 to take a value back (a response written again replaces its earlier entry).
export const tally = () => ({ sum: undefined, count: 0 });

export function add(t, value, sign = 1) {
  if (!isNumber(value)) return;
  t.count += sign;
  t.sum = t.count > 0 ? (t.sum ?? 0) + sign * value : undefined;
}
