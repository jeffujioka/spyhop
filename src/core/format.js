// Copied from herdr-session-stats (src/format.js).
//
// Text of the card's figures. Takes stats as `readStats` returns them: a number or 'n/a'.

import { NA } from './providers/index.js';

// A token count as the card writes a size: 200000 is "200k", 1000000 is "1M".
export function formatTokens(tokens) {
  if (tokens < 1e3) return String(tokens);
  const thousands = Math.round(tokens / 1e3);
  return thousands < 1e3 ? `${thousands}k` : `${+(tokens / 1e6).toFixed(1)}M`;
}

// A share of 1 as the card writes a percent: 0.25 is "25%". Takes a number or 'n/a'.
export function formatPercent(share) {
  return share === NA ? NA : `${Math.round(share * 100)}%`;
}

// A cost in dollars as the card writes it: "$1.50". Takes a number or 'n/a'.
export function formatCost(usd) {
  return usd === NA ? NA : `$${usd.toFixed(2)}`;
}

// A cost per hour as the live panel writes it: "$9.00/h". Takes a number or 'n/a'.
export function formatCostPerHour(usd) {
  return usd === NA ? NA : `${formatCost(usd)}/h`;
}

// Text of a duration: "450ms", "12s", "1m 30s", "1h 05m". Takes a number or 'n/a'.
export function formatDuration(ms) {
  if (ms === NA) return NA;
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor(seconds / 60) % 60)}m`;
}

// How long an agent has been in its state, as the live panel writes it: "45s", "3m", "2h 05m".
// Takes a number or 'n/a'.
export function formatAge(ms) {
  if (ms === NA) return NA;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  // an hour and over is written as a duration is
  return formatDuration(ms);
}

// A time left as the live panel counts it down, in whole seconds rounded up, so it reads 0:00 only
// once the time is up: 42000 is "0:42", 90000 is "1:30". Takes a number.
export function formatCountdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// A time of day as the live panel writes it: local "15:33". Takes epoch ms.
export function formatClock(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A time as the live panel writes it within the week: local "Wed 15:33". Takes epoch ms or 'n/a'.
export function formatDay(ms) {
  return ms === NA ? NA : `${DAYS[new Date(ms).getDay()]} ${formatClock(ms)}`;
}

// A time as the live panel writes it with its date: local "Wed 25 Nov, 15:33". Takes epoch ms or
// 'n/a'.
export function formatDate(ms) {
  if (ms === NA) return NA;
  const date = new Date(ms);
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}, ${formatClock(ms)}`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// A day of a range as the live panel writes it: '2026-11-27' (src/core/days.js) is "27 November".
export function formatDayMonth(day) {
  return `${Number(day.slice(8, 10))} ${MONTH_NAMES[Number(day.slice(5, 7)) - 1]}`;
}

// A month of a range as the live panel writes it: '2025-12' is "December 2025".
export function formatMonthYear(month) {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

// A day of a range as a mark under a chart: '2026-11-27' is "27 Nov".
export function formatDayShort(day) {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

// A month of a range as a mark under a chart: '2025-12' is "Dec".
export function formatMonthShort(month) {
  return MONTHS[Number(month.slice(5, 7)) - 1];
}

// A short wait as the live panel writes it, to a tenth of a second: "2.9s"; from a minute on as a
// duration is. Takes a number or 'n/a'.
export function formatSeconds(ms) {
  if (ms === NA) return NA;
  return ms < 60_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatDuration(ms);
}

// A count with its thousands marked: 1206 is "1,206". Takes a number or 'n/a'.
export function formatCount(n) {
  return n === NA ? NA : Math.round(n).toLocaleString('en-US');
}

// A figure formatted, or 'n/a' when it is not known.
export const orNa = (value, format) => (value === NA ? NA : format(value));

// A folder's own name, the last part of its path: "/Users/me/app" is "app". The root is "/".
export function formatFolderName(folder) {
  if (folder == null) return NA;
  const path = folder.replace(/\/+$/, '');
  return path === '' ? '/' : path.slice(path.lastIndexOf('/') + 1);
}

// A folder's path for reading: the start that is `home` is written "~". `home` is null for a
// folder on a machine whose home is not known, which is written in full.
export function formatHomePath(folder, home) {
  if (folder == null) return NA;
  if (home && (folder === home || folder.startsWith(`${home}/`))) return `~${folder.slice(home.length)}`;
  return folder;
}

// An Orca agent's title without the mark its harness paints in front of the session's title.
// omp sets the terminal title to `π > <session title>`, or `OMP > <session title>` (seen in an
// Orca terminal on this Mac); an omp extension may paint it instead as
// `π <mark> <session title> - <folder name>`, the mark being `-` (idle), `!` (needs input) or a
// braille spinner frame that changes every 100 ms while the agent works. So for omp the leading
// `π ` or `OMP `, one such mark and its space are dropped, and the title stays one string however
// the spinner turns (the title may start with a private-use glyph, which is part of it). Another
// harness's title, and a missing one (null), is taken as it is (no other prefix is known).
export function withoutTitleMark(title, harness) {
  return harness === 'omp' && title != null ? title.replace(/^(?:π|OMP) [>!\-\u2800-\u28FF]\s/u, '') : title;
}

// The title of a session as the card shows it, from the Orca agent's title: without its mark
// (withoutTitleMark) and, for omp, without a trailing ` - ` and the folder's name, which the
// omp extension adds. An untitled session's title is the folder's name, and then there is
// nothing to show: null. Otherwise a `{ value, tone }` figure.
export function formatSessionTitle(title, folder, harness) {
  const name = formatFolderName(folder);
  let text = (withoutTitleMark(title, harness) ?? '').trim();
  if (harness === 'omp' && folder != null && text.endsWith(` - ${name}`)) text = text.slice(0, -` - ${name}`.length).trim();
  return text === '' || text === name ? null : { value: text, tone: 'normal' };
}

// A git remote's URL for reading: without the scheme, the user (credentials are masked
// already) and the `.git` end, and an scp-style `host:path` written `host/path`:
// "git@github.com:org/repo.git" is "github.com/org/repo". null stays null.
export function formatRemote(url) {
  if (url == null) return null;
  return url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^/@]*@/, '')
    .replace(/^([^/:]+):(?!\d+\/)/, '$1/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}
