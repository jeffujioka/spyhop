// Copied from herdr-session-stats (src/providers/shared.js).
//
// Helpers shared by the providers: the figures that two of them derive in the same way, and
// the number test. Pure and runtime-neutral, like the providers.

export const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// Hit rate is over the session's token counts (D6); it needs all three counts to be logged
// and a non-zero total. The counts are `tally`s (src/core/providers/jsonl.js).
export function cacheRate({ input, cacheRead, cacheWrite }) {
  if (input.sum === undefined || cacheRead.sum === undefined || cacheWrite.sum === undefined) return {};
  const total = input.sum + cacheRead.sum + cacheWrite.sum;
  return total > 0 ? { cacheHitRate: cacheRead.sum / total } : {};
}

// Burn rate is derived from the session's own duration, cost and token figures (the values
// the provider's `duration`, `cost` and `tokens` gave, any of them absent); a session that
// has not lasted (duration 0) or lacks the input reads n/a. A provider that leaves out
// `costUsd` has no cost per hour.
export function burnRate({ durationMs, costUsd, totalTokens }) {
  if (!(durationMs > 0)) return {};
  const figures = {};
  if (costUsd !== undefined) figures.burnCostPerHour = costUsd / (durationMs / 3600000);
  if (totalTokens !== undefined) figures.burnTokensPerMin = totalTokens / (durationMs / 60000);
  return figures;
}
