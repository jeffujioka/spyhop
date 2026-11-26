// Copied from herdr-session-stats (src/providers/omp-sources.js).
//
// The omp side of a card's I/O: where omp keeps a folder's sessions and the plain values its
// figures need besides the session text (src/core/providers/omp.js reads only values handed
// in). It is the omp provider's `createSessions` hook (see the stats-shape header of
// src/core/providers/index.js); the card builder asks the registry and knows nothing of omp.
// Runtime-neutral: it takes the plugin's runner and text reader bound to an Orca host, and runs
// only read-only programs there: `find` with `stat`, `head`, `tail` and `dd` (through the session
// reader), and `sqlite3 -readonly`. omp's own CLI is not run: `omp config list` and `omp config
// get` write omp's agent.db and its natives folder when they start, so the compaction settings
// are read from config.yml itself.

import { createLimit } from '../limit.js';
import { createTtlCache } from '../ttl-cache.js';
import { parseEntries } from './jsonl.js';
import { ompProvider } from './omp.js';
import { findNamedFiles, findSessionFile, listSessionFiles, sessionReaders } from './session-files.js';

// Most title reads (`head`) run at once by one hook.
const TITLE_READS = 4;

// The model catalogue and the compaction settings change rarely; they are read again after
// this long rather than at every refresh.
export const SLOW_SOURCE_TTL_MS = 60 * 1000;

// Name of omp's session folder for a working folder (herdr-session-stats
// docs/omp-session-format.md): under the home folder it is the path below home with `/` as `-`
// and a `-` in front (home itself is `-`); elsewhere it is the path with `/` as `-` between two
// dashes on each end. omp's own rule has a third case for folders under the system temp
// folder, which spyhop leaves out: such a folder has no linked session, so its card reads n/a.
export function sessionDirSlug(cwd, home) {
  const flat = (path) => path.replace(/[/\\:]/g, '-');
  const path = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
  if (home && (path === home || path.startsWith(`${home}/`))) return `-${flat(path.slice(home.length + 1))}`;
  return `--${flat(path.replace(/^[/\\]/, ''))}--`;
}

// Latest provider named by an assistant message of a session tail, or null. The catalogue
// holds one row per provider, so the model's window is looked up in its provider's.
function lastAssistantProvider(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"role":"assistant"')) continue;
    try {
      const provider = JSON.parse(lines[i]).message?.provider;
      if (typeof provider === 'string') return provider;
    } catch {
      // a line cut at the start of the tail window
    }
  }
  return null;
}

// A value of the small YAML subset omp writes: a number, true or false, null, a quoted or a
// plain string, or `{}`. Anything else throws, so the settings are unknown (null) rather than
// misread: a flow map with content, a list, a block scalar, an anchor; a number in another
// notation (`1e5`, `1_000`, `0x10`), a YAML 1.1 word for a boolean or null (`no`, `On`), and
// a quoted string with text after it, which a plain string would swallow.
function parseScalar(raw) {
  const quoted = /^"([^"]*)"\s*(?:#.*)?$|^'([^']*)'\s*(?:#.*)?$/.exec(raw);
  if (quoted) return quoted[1] ?? quoted[2];
  const value = raw.replace(/\s+#.*$/, '').trim();
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (value === '{}') return {};
  if (/^[{[|>&*!%@`"'\d.+-]/.test(value) || /^(y|n|yes|no|on|off|true|false|null)$/i.test(value)) {
    throw new Error(`unsupported YAML value: ${value}`);
  }
  return value;
}

// Mapping of `lines` ({ indent, text }) from `from`, whose keys sit at `indent`; returns
// `{ map, next }`. A key with no value takes the deeper block under it, else null.
function parseMap(lines, from, indent) {
  const map = {};
  let i = from;
  while (i < lines.length && lines[i].indent >= indent) {
    if (lines[i].indent !== indent) throw new Error('unexpected indentation');
    const match = /^(?:"([^"]*)"|'([^']*)'|([^\s"'#-][^:]*?))\s*:(?:\s+(.*))?$/.exec(lines[i].text);
    if (!match) throw new Error(`unsupported YAML line: ${lines[i].text}`);
    const key = match[1] ?? match[2] ?? match[3];
    const rest = match[4]?.trim();
    i++;
    if (rest) {
      map[key] = parseScalar(rest);
    } else if (i < lines.length && lines[i].indent > indent) {
      const child = parseMap(lines, i, lines[i].indent);
      map[key] = child.map;
      i = child.next;
    } else {
      map[key] = null;
    }
  }
  return { map, next: i };
}

// The `compaction` block of omp's config.yml as an object (`{}` when the file sets none), or
// null when the block uses YAML this reader does not understand: the trigger point is then
// unknown and the headroom reads n/a. Only keys the file sets appear; omp's defaults are not
// copied here, and the provider treats an absent key as the default.
export function parseCompactionConfig(text) {
  try {
    const lines = [];
    for (const raw of text.split('\n')) {
      if (/^\s*(#.*)?$/.test(raw) || /^---\s*$/.test(raw)) continue;
      if (/^\t|^ *\t/.test(raw)) return null;
      lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim() });
    }
    const at = lines.findIndex((line) => line.indent === 0 && /^compaction\s*:/.test(line.text));
    if (at < 0) return {};
    const inline = lines[at].text.replace(/^compaction\s*:/, '').trim();
    if (inline) {
      const value = parseScalar(inline);
      return value && typeof value === 'object' ? value : null;
    }
    if (!(lines[at + 1]?.indent > 0)) return {};
    return parseMap(lines, at + 1, lines[at + 1].indent).map;
  } catch {
    return null;
  }
}

// Models of one provider from the newest catalogue row (herdr-session-stats decision D8 (b)):
// `[{ id, contextWindow }]`.
// `provider` comes from a session file, so it is only used when it is a plain name.
function catalogueQuery(provider) {
  return (
    "SELECT json_extract(j.value, '$.id') AS id, json_extract(j.value, '$.contextWindow') AS contextWindow " +
    'FROM model_cache, json_each(model_cache.models) AS j ' +
    'WHERE model_cache.provider_id = (SELECT provider_id FROM model_cache ' +
    `WHERE substr(provider_id, 1, ${provider.length + 1}) = '${provider}:' ORDER BY updated_at DESC LIMIT 1)`
  );
}

// The folder omp keeps the sessions of a working folder in.
const sessionDir = (cwd, home) => `${home}/.omp/agent/sessions/${sessionDirSlug(cwd, home)}`;

// The title of a session, from the first line of its file: omp writes the `title` entry there
// and rewrites it in place when the title changes (it always equals the latest `title_change`
// entry), so one short read gives it. '' when the line is not a title entry (the session then
// matches no agent title and takes an untitled agent, see shareSessions); null when the line
// could not be read (a file being written, a failed program).
async function readTitle(run, path) {
  try {
    const { code, stdout } = await run('head', ['-n', '1', '--', path]);
    const entry = code === 0 ? parseEntries(stdout)[0] : null;
    if (!entry) return null;
    return entry.type === 'title' && typeof entry.title === 'string' ? entry.title : '';
  } catch {
    return null;
  }
}

// `execOn(machine)` and `readTextOn(machine)`: the plugin's runner and text reader bound to an
// Orca host (null: this computer). State kept between calls (the
// per-machine session readers, the slow sources) lives in the returned object. `kept`: the
// scans of omp session files an earlier run kept (see `sessionReaders`).
export function createOmpSessions({ execOn, readTextOn, kept }) {
  // each machine's reader, which keeps that machine's per-file totals
  const readers = sessionReaders(execOn, ompProvider.fold, kept);

  // machine and path -> { mtimeMs, size, title }: a title is read again only when the file
  // changed, so a refresh of quiet files runs no program. One entry per file, replaced when it
  // changes. A line that could not be read is kept as '' too: a file being written changes its
  // size when the line is whole, and is read again then.
  const titles = new Map();
  const titleReads = createLimit(TITLE_READS);
  async function titleOf(machine, file) {
    const key = `${machine ?? ''}\0${file.path}`;
    const hit = titles.get(key);
    if (hit?.mtimeMs === file.mtimeMs && hit.size === file.size) return hit.title;
    const title = (await readTitle(execOn(machine), file.path)) ?? '';
    titles.set(key, { mtimeMs: file.mtimeMs, size: file.size, title });
    return title;
  }

  // the slow sources, each reused for SLOW_SOURCE_TTL_MS, also by agents asking at once
  const cached = createTtlCache(SLOW_SOURCE_TTL_MS);

  // A missing sqlite3 or database, or a model of no window, reads as null (the figures read n/a).
  function readCatalogue(machine, home, provider, now) {
    if (!/^[\w.-]+$/.test(provider ?? '')) return null;
    return cached(`catalogue ${machine}\0${provider}`, now, async () => {
      try {
        const db = `${home}/.omp/agent/models.db`;
        const { code, stdout } = await execOn(machine)('sqlite3', ['-readonly', '-json', db, catalogueQuery(provider)]);
        if (code !== 0 || stdout.trim() === '') return null;
        const rows = JSON.parse(stdout);
        return Array.isArray(rows) ? rows : null;
      } catch {
        return null;
      }
    });
  }

  // Project-level config files are not read, so a setting made only there is not seen.
  function readCompaction(machine, home, now) {
    return cached(`compaction ${machine}`, now, async () => {
      try {
        const text = await readTextOn(machine)(`${home}/.omp/agent/config.yml`);
        return text == null ? null : parseCompactionConfig(text);
      } catch {
        return null;
      }
    });
  }

  return {
    // The session file the agent's folder links to (`{ path, mtimeMs, size }`) that is not in
    // `except`, or null.
    link({ machine, cwd, home, os, except }) {
      return findSessionFile(execOn(machine), { dir: sessionDir(cwd, home), os, except });
    },

    // The session file each of `sessionIds` names in the folder, or null: omp names a session
    // file `<start time>_<id>.jsonl`.
    named({ machine, cwd, home, os }, sessionIds) {
      const dir = sessionDir(cwd, home);
      return findNamedFiles(execOn(machine), { dir, os }, sessionIds, (path, id) => path.endsWith(`_${id}.jsonl`));
    },

    // The `limit` newest session files of the folder not in `except` (see listSessionFiles),
    // each with its title when there are two or more to share out (one goes to its agent
    // whatever its title), TITLE_READS read at a time.
    async list({ machine, cwd, home, os, limit, except }) {
      const files = await listSessionFiles(execOn(machine), { dir: sessionDir(cwd, home), os, limit, except });
      if (files.length < 2) return files;
      return Promise.all(files.map((file) => titleReads(async () => ({ ...file, title: await titleOf(machine, file) }))));
    },

    // The `input` of `readStats('omp', input, now)` for a linked file.
    async read(file, { machine, home, now }) {
      const { text, sources, state } = await readers.on(machine).read(file);
      const [catalogue, compaction] = await Promise.all([
        readCatalogue(machine, home, lastAssistantProvider(text), now),
        readCompaction(machine, home, now),
      ]);
      return { text, state, sources: { ...sources, catalogue, compaction } };
    },

    // The finished scans of the files read, to keep for a later run (see `sessionReaders`).
    scanned: readers.scanned,
  };
}
