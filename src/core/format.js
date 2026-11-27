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

// The title of a session as the card shows it, from the Orca agent's title. omp sets the
// terminal title to `π > <session title>` or `π - <session title>` (the title may start with a
// private-use glyph, which is part of it), so that `π > ` or `π - ` prefix is dropped for omp;
// another harness's title is taken as it is (no other prefix is known). An untitled session's
// title is the folder's name, and then there is nothing to show: null. Otherwise a
// `{ value, tone }` figure.
export function formatSessionTitle(title, folder, harness) {
  const text = (harness === 'omp' ? (title ?? '').replace(/^π [>-]\s/, '') : title ?? '').trim();
  return text === '' || text === formatFolderName(folder) ? null : { value: text, tone: 'normal' };
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
