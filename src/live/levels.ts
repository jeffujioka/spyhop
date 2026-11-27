// The level of a context, wherever the live panel draws one: ok under 60% of the window, warning
// from 60% to under 75%, hot from 75% to under 90%, critical at 90% and over. The percent is the
// one the panel writes (rounded), so a context written 75% is never drawn at the level of 74%.

export type Level = 'ok' | 'warning' | 'hot' | 'critical';

// `share`: the context's share of the window, 0..1.
export function levelOf(share: number): Level {
  const percent = Math.round(share * 100);
  if (percent < 60) return 'ok';
  if (percent < 75) return 'warning';
  if (percent < 90) return 'hot';
  return 'critical';
}
