// Copied from herdr-session-stats (src/providers/shared.js).
//
// Helpers shared by the providers: the figures that two of them derive in the same way, and
// the number test. Pure and runtime-neutral, like the providers.

export const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// A token count of one model call for its series; a count the call did not log adds nothing.
export const tokenCount = (value) => (isNumber(value) ? value : 0);

// The session's own model calls and the time of its first message (`calls` and `firstMessage`
// of a fold's state). Both need the whole file: a tail window holds only some of the calls and
// not the first message, so unless the state is the whole file's they read n/a.
export function wholeSession({ calls, firstMessage }, whole) {
  if (!whole) return {};
  return isNumber(firstMessage) ? { calls, firstMessageMs: firstMessage } : { calls };
}

// Hit rate is over the session's token counts (herdr-session-stats decision D6); it needs all
// three counts to be logged and a non-zero total. The counts are `tally`s
// (src/core/providers/jsonl.js).
export function cacheRate({ input, cacheRead, cacheWrite }) {
  if (input.sum === undefined || cacheRead.sum === undefined || cacheWrite.sum === undefined) return {};
  const total = input.sum + cacheRead.sum + cacheWrite.sum;
  return total > 0 ? { cacheHitRate: cacheRead.sum / total } : {};
}

// Burn rate is derived from the duration, cost and token figures the provider hands in, any of
// them absent: its `duration` and `tokens` figures and the cost of its model calls (omp's `cost`
// figure; opencode's sum of its calls' costs, as its own session total can sit above them). A
// session that has not lasted (duration 0) or lacks the input reads n/a. A provider that leaves
// out `costUsd` has no cost per hour.
export function burnRate({ durationMs, costUsd, totalTokens }) {
  if (!(durationMs > 0)) return {};
  const figures = {};
  if (costUsd !== undefined) figures.burnCostPerHour = costUsd / (durationMs / 3600000);
  if (totalTokens !== undefined) figures.burnTokensPerMin = totalTokens / (durationMs / 60000);
  return figures;
}
