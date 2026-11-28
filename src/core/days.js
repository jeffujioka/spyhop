// The calendar days of this computer's time zone that the Spend tab sums over: the day of a
// time, and the days (or, for a year, the months) of a range that ends today.

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

// `YYYY-MM-DD` of the epoch ms `t` in this computer's time zone.
export const dayOf = (t) => dayKey(new Date(t));

// Epoch ms of midnight in this computer's time zone `days` days before the day of the epoch ms
// `now`.
export function midnightBefore(now, days) {
  const today = new Date(now);
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - days).getTime();
}

// The days a range spans as of the epoch ms `now`: Day is today; Week the 7 and Month the 30
// days that end today, a point each; Year the 12 calendar months that end with this month, a
// point each (`YYYY-MM`). Day has no chart over time, so no points.
export function rangeDays(range, now) {
  const today = new Date(now);
  const [y, m, d] = [today.getFullYear(), today.getMonth(), today.getDate()];
  if (range === 'day') return { from: dayKey(today), to: dayKey(today), by: null, points: [] };
  if (range === 'year') {
    const points = Array.from({ length: 12 }, (_, i) => monthKey(new Date(y, m - 11 + i, 1)));
    return { from: points[0], to: points.at(-1), by: 'month', points };
  }
  const length = range === 'week' ? 7 : 30;
  const points = Array.from({ length }, (_, i) => dayKey(new Date(y, m, d - length + 1 + i)));
  return { from: points[0], to: points.at(-1), by: 'day', points };
}
