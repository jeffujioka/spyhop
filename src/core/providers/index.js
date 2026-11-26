// Copied from herdr-session-stats (src/providers/index.js).
//
// Provider registry: the one seam between a harness's session files and the card.
//
// A provider is `{ readStats(input, now) }`, synchronous, and returns a partial stats object.
// `input` is whatever the provider reads from (omp and Claude Code: the jsonl text of the
// session, or `{ text, sources, state }` with the files already read by the caller, `text`
// being the tail window of a large file and `state` the provider's accumulator over the whole
// file; opencode: `{ messages, compactions }`, the rows of the session read from its
// database); the registry does not look inside it. A provider never reads a file itself: the
// plugin does its I/O asynchronously and hands plain values in. `now` is epoch milliseconds; a
// figure measured from the present (cacheLeftMs) reads it, the others ignore it.
//
// A provider that reads a jsonl file also carries `fold(state, entries) -> state`, the
// accumulator of the figures that need the whole file: it adds parsed entries to `state`
// (undefined starts a new one), so the state is the same whether a file is folded at once or
// in pieces, which is how src/core/refresh.js reads a file larger than the tail window (once in
// chunks, then only what was appended). Its `createSessions` hands the reader this `fold`.
//
// A provider may also carry `createSessions({ execOn, readTextOn, kept })`, the hook that finds its
// sessions and reads their plain-value sources; it lives in the provider's own
// `src/core/providers/<harness>-sources.js`, so adding a harness touches only its provider, its
// sources file and one registry line below. `execOn(machine)` and `readTextOn(machine)` run a
// program and read a text file on an Orca host (null: this computer), through the plugin's
// runner (src/exec.ts), read-only use only; `kept` is the scans of this provider's session
// files that an earlier run kept (see `sessionReaders`, session-files.js). `createSessions`
// runs once per card builder and returns
// (a session object a hook gives holds at least the fields its signature names here; a hook may
// add fields of its own, as opencode adds `folder`, and gets the object back as it gave it)
//   named({ machine, cwd, home, os }, sessionIds) -> Promise<Array<{ path, mtimeMs, size } | null>>
//     for each of the Orca agents' sessionIds (null: none), the session on the folder's host
//     that the id names by the harness's own rule, or null; the hook alone knows that rule.
//     The session can be one of another folder than the agent's workspace folder `cwd`: a
//     harness that ran in a sub-folder of it keeps its session with that sub-folder's. So no
//     built-in hook reads `cwd` here: omp and Claude Code look in every session folder of the
//     host, opencode in every row of its database;
//   An agent no sessionId named links by one of the next two, of which a hook has one:
//   list({ machine, cwd, home, os, except }) -> Promise<Array<{ path, mtimeMs, size, title }>>
//     for a harness that writes a title into its sessions (omp): the sessions such an agent
//     of the workspace folder `cwd` may link to, newest first, each with its title: those whose
//     path is not in `except` (the named ones) and whose recorded folder is `cwd` or a folder
//     below it. Each agent gets the one whose title its own title contains, and none when no
//     title matches (`shareSessions`, src/core/session-link.js). The hook bounds what one
//     call reads, not which sessions it gives: a session it has read before costs nothing
//     while unchanged, and one it has not read yet is given by a later call;
//   link({ machine, cwd, home, os, except }) -> Promise<{ path, mtimeMs, size } | null>
//     for a harness without titles (Claude Code, opencode): the session all such agents of
//     the workspace folder `cwd` link to, the newest one of that folder itself, never of a
//     folder below it, whose path is not in `except`, however long ago it changed (see
//     session-link.js), or null; `home` and `os` (`uname -s`) are the host's;
//   read(file, { machine, home, now })     -> Promise<input>
//     the `input` of this provider's `readStats` for a linked file;
//   folder(file, { machine })              -> Promise<string | null>
//     optional: the folder the session of a linked file records as its own (omp: the `cwd` of
//     its `session` entry; Claude Code: the `cwd` of its first entry that holds one; opencode:
//     the `directory` of its row), which is the card's folder and where its git facts are read;
//     null when it cannot be told, and the card then keeps the agent's workspace folder, as it
//     does for a provider without `folder`. It is the one way a card learns its session's
//     folder, however the file was linked (`named`, `list` or `link`). The builder asks it
//     once `read` of the file has resolved, with the file as the hook gave it (a hook may keep
//     more on it than `path`, `mtimeMs` and `size`, as opencode does the folder), so a hook
//     answers from what that read or its listing already gave and runs a program only where
//     they did not;
//   scanned()                              -> { changed, scans }
//     optional, for a provider that scans session files: the finished scans of the files read,
//     to keep for a later run, and whether any changed since it was last asked.
// Each may reject: the card then reads n/a (after a `folder` that rejects it keeps its figures
// and the workspace folder). A provider without the hook yields no session.
//
// Stats shape (single place; herdr-session-stats docs/omp-session-format.md repeats it with the
// omp sources).
// Every figure is a plain value or the string 'n/a' (NA); the card formats, never estimates.
// Units: ms for times, tokens for sizes, USD for money, 0..1 for rates.
//
//   model              string   model of the latest assistant message
//   durationMs         number   first to last message
//   totalTokens        number   sum of usage.totalTokens
//   contextTokens      number   latest context usage
//   contextMax         number   model's maximum context window
//   contextPercent     number   contextTokens / contextMax, 0..1
//   headroomTokens     number   tokens left before the autocompaction trigger
//   autocompactions    number   autocompactions recorded in the session
//   cacheHitRate       number   cacheRead / (input + cacheRead + cacheWrite)
//   cacheHits          number   assistant turns with cacheRead > 0
//   cacheMisses        number   assistant turns with cacheRead 0
//   cacheLeftMs        number   time until the prompt cache is cold; 0 = already cold
//   costUsd            number   sum of the harness's logged cost.total
//   burnCostPerHour    number   costUsd per hour of session
//   burnTokensPerMin   number   totalTokens per minute of session
//   sinceActivityMs    number   now minus the last message
//   latencyMs          number   last turn: assistant reply minus the user message that began it
//   thinkingLevel      string   thinking level of the session
//   premiumRequests    number   sum of usage.premiumRequests
//
// The result of readStats also carries `harness`, the name asked for, which is never n/a.

import { ompProvider } from './omp.js';
import { createOmpSessions } from './omp-sources.js';
import { opencodeProvider } from './opencode.js';
import { createOpencodeSessions } from './opencode-sources.js';
import { claudeProvider } from './claude.js';
import { createClaudeSessions } from './claude-sources.js';

export const NA = 'n/a';

export const STAT_FIELDS = [
  'model',
  'durationMs',
  'totalTokens',
  'contextTokens',
  'contextMax',
  'contextPercent',
  'headroomTokens',
  'autocompactions',
  'cacheHitRate',
  'cacheHits',
  'cacheMisses',
  'cacheLeftMs',
  'costUsd',
  'burnCostPerHour',
  'burnTokensPerMin',
  'sinceActivityMs',
  'latencyMs',
  'thinkingLevel',
  'premiumRequests',
];

const providers = new Map();

export function registerProvider(harness, provider) {
  providers.set(harness, provider);
}

// Built-in providers. One line each; omp.js does not import this file, so there is no cycle.
registerProvider('omp', { ...ompProvider, createSessions: createOmpSessions });
registerProvider('opencode', { ...opencodeProvider, createSessions: createOpencodeSessions });
registerProvider('claude-code', { ...claudeProvider, createSessions: createClaudeSessions });

// Always returns every field: the provider's value where it gave one, else n/a.
export function readStats(harness, input, now) {
  const provided = providers.get(harness)?.readStats(input, now) ?? {};
  const stats = { harness };
  for (const field of STAT_FIELDS) {
    stats[field] = provided[field] ?? NA;
  }
  return stats;
}

// A provider's session hook for the card builder, or null for a provider without one (its
// harness yields no linked session, so every figure reads n/a). The builder passes the
// provider's `createSessions` the plugin's I/O bound to an Orca host, once per builder.
export function createSessions(harness, io) {
  return providers.get(harness)?.createSessions?.(io) ?? null;
}
