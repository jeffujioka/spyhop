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
import { findNamedFiles, listFilesOfFolders, sessionReaders } from './session-files.js';

// Most `head` reads (a session's title and the folder it records) run at once by one hook.
const HEAD_READS = 4;

// Most heads one listing reads for the agents no session id named: those of the newest listed
// files whose head is not known yet or whose file changed since. It bounds what a refresh
// costs, not which sessions an agent may link to: a head once read costs nothing while its file
// is unchanged, so a workspace with years of sessions is read 32 heads per refresh, HEAD_READS
// at a time, until every head is known, and an idle agent's old session is reached then.
export const HEADS_PER_LISTING = 32;

// The model catalogue and the compaction settings change rarely; they are read again after
// this long rather than at every refresh.
export const SLOW_SOURCE_TTL_MS = 60 * 1000;

// Name of omp's session folder for a working folder (herdr-session-stats
// docs/omp-session-format.md), as its start and its end: under the home folder it is the path
// below home with `/` as `-` and a `-` in front (home itself is `-`); elsewhere it is the path
// with `/` as `-` between two dashes on each end. The session folder of a folder below `cwd`
// starts with the start of `cwd`'s own, and so does that of a folder beside it whose name
// starts alike (`projects-old` beside `projects`). omp's own rule has a third case for folders
// under the system temp folder, which spyhop leaves out: such a folder has no linked session,
// so its card reads n/a.
export function slugParts(cwd, home) {
  const flat = (path) => path.replace(/[/\\:]/g, '-');
  const path = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
  if (home && (path === home || path.startsWith(`${home}/`))) return [`-${flat(path.slice(home.length + 1))}`, ''];
  return [`--${flat(path.replace(/^[/\\]/, ''))}`, '--'];
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

// The folder omp keeps every working folder's session folder in.
const sessionsRoot = (home) => `${home}/.omp/agent/sessions`;

// The text of the first `lines` lines of a file, or null when it could not be read (a failed
// program).
async function readHead(run, path, lines) {
  try {
    const { code, stdout } = await run('head', ['-n', String(lines), '--', path]);
    return code === 0 ? stdout : null;
  } catch {
    return null;
  }
}

// The title of a session, from `text`, which starts with the file's first line: omp writes the
// `title` entry there and rewrites it in place when the title changes (it always equals the
// latest `title_change` entry). '' when the line is not a title entry: the session then matches
// no agent title (see shareSessions).
function titleIn(text) {
  const [entry] = parseEntries(text.split('\n', 1)[0]);
  return entry?.type === 'title' && typeof entry.title === 'string' ? entry.title : '';
}

// The `session` entry is one of the first lines of an omp session file: the first, or the
// second after a `title` entry.
const SESSION_ENTRY_LINES = 2;

// The folder a session records as its own, the `cwd` of its `session` entry, from `text`, which
// starts with the file's first lines; null when those hold no such entry or it names no folder.
// A path that is not absolute names none: git would be run in it relative to the plugin's own
// process folder.
function recordedFolder(text) {
  const head = text.split('\n', SESSION_ENTRY_LINES).join('\n');
  const entry = parseEntries(head).find(({ type }) => type === 'session');
  return typeof entry?.cwd === 'string' && entry.cwd.startsWith('/') ? entry.cwd : null;
}

// Whether `folder` is the folder `top` or one below it.
function isAtOrBelow(folder, top) {
  const base = top.replace(/\/+$/, '');
  return folder === base || folder.startsWith(`${base}/`);
}

// `execOn(machine)` and `readTextOn(machine)`: the plugin's runner and text reader bound to an
// Orca host (null: this computer). State kept between calls (the
// per-machine session readers, the slow sources) lives in the returned object. `kept`: the
// scans of omp session files an earlier run kept (see `sessionReaders`).
export function createOmpSessions({ execOn, readTextOn, kept }) {
  // each machine's reader, which keeps that machine's per-file totals
  const readers = sessionReaders(execOn, ompProvider.fold, kept);

  // machine and path -> { mtimeMs, size, title, cwd }: what the head of a session file told,
  // its title (see titleIn) and the folder it records (see recordedFolder), with the time and
  // size of the file it was read from. One entry per file, replaced when the file is read again.
  // - The title holds while the file is unchanged, so a refresh of quiet files runs no program.
  // - A folder found is kept for good, since omp writes the `session` entry once, when the
  //   session starts; null (no such entry in what was read) is asked again only when the file
  //   changed.
  // - A head that could not be read (a failed program, as when ssh fails) leaves no entry and
  //   replaces none: nothing was learned, so the next call reads the file again.
  const heads = new Map();
  const headReads = createLimit(HEAD_READS);
  const keyOf = (machine, file) => `${machine ?? ''}\0${file.path}`;
  const unchanged = (hit, file) => hit.mtimeMs === file.mtimeMs && hit.size === file.size;
  function knownFolder(machine, file) {
    const hit = heads.get(keyOf(machine, file));
    return hit && (hit.cwd !== null || unchanged(hit, file)) ? hit : null;
  }
  // The entry of `file`, from one `head` when the file changed since it was read, or never was.
  // When that read fails it is the earlier entry, or null without one.
  async function headOf(machine, file) {
    const hit = heads.get(keyOf(machine, file));
    if (hit && unchanged(hit, file)) return hit;
    const text = await headReads(() => readHead(execOn(machine), file.path, SESSION_ENTRY_LINES));
    if (text === null) return hit ?? null;
    const head = { mtimeMs: file.mtimeMs, size: file.size, title: titleIn(text), cwd: hit?.cwd ?? recordedFolder(text) };
    heads.set(keyOf(machine, file), head);
    return head;
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
    // The session file each of `sessionIds` names on the host, or null: omp names a session
    // file `<start time>_<id>.jsonl`, in the session folder of the folder the session ran in,
    // which can be another than the agent's workspace folder (a sub-folder of it, for one).
    named({ machine, home, os }, sessionIds) {
      const where = { dir: sessionsRoot(home), os, depth: 2, pattern: (id) => `*_${id}.jsonl` };
      return findNamedFiles(execOn(machine), where, sessionIds, (path, id) => path.endsWith(`_${id}.jsonl`));
    },

    // The sessions an agent of the workspace folder `cwd` that no id named may link to by
    // title: those not in `except` whose recorded folder is `cwd` or a folder below it, newest
    // first, each with its title. One listing prints the files of the session folders named
    // like `cwd`'s; the name does not tell a sub-folder from a folder beside `cwd` that starts
    // alike, so the recorded folder decides, and a session whose folder is not known is none
    // of them. A file whose head is known and unchanged, or known to be of another folder,
    // costs no read; of the others the HEADS_PER_LISTING newest are read in this call and the
    // rest in later ones, which then give their sessions too. A changed file left for a later
    // call keeps the title last read.
    async list({ machine, cwd, home, os, except }) {
      const listed = await listFilesOfFolders(execOn(machine), { dir: sessionsRoot(home), os, prefix: slugParts(cwd, home)[0] });
      let reads = 0;
      const found = await Promise.all(
        listed
          .filter((file) => !except.includes(file.path))
          .map(async (file) => {
            const hit = heads.get(keyOf(machine, file));
            const settled = hit && (unchanged(hit, file) || (hit.cwd !== null && !isAtOrBelow(hit.cwd, cwd)));
            if (settled || reads >= HEADS_PER_LISTING) return { file, head: hit };
            reads += 1;
            return { file, head: await headOf(machine, file) };
          }),
      );
      return found.filter(({ head }) => head?.cwd && isAtOrBelow(head.cwd, cwd)).map(({ file, head }) => ({ ...file, title: head.title }));
    },

    // The `input` of `readStats('omp', input, now)` for a linked file. A file that is whole in
    // the text read also tells the folder it records, for `folder`.
    async read(file, { machine, home, now }) {
      const { text, sources, state } = await readers.on(machine).read(file);
      if (sources.wholeFile && !knownFolder(machine, file)) {
        heads.set(keyOf(machine, file), { mtimeMs: file.mtimeMs, size: file.size, title: titleIn(text), cwd: recordedFolder(text) });
      }
      const [catalogue, compaction] = await Promise.all([
        readCatalogue(machine, home, lastAssistantProvider(text), now),
        readCompaction(machine, home, now),
      ]);
      return { text, state, sources: { ...sources, catalogue, compaction } };
    },

    // The folder the session of a linked file records, or null. What the listing by title or
    // `read` of a file that is whole in its window found answers; the head of a larger file
    // linked by its id is outside that window and is read once, by one `head`, and again at
    // the next call when that read failed.
    async folder(file, { machine }) {
      return (knownFolder(machine, file) ?? (await headOf(machine, file)))?.cwd ?? null;
    },

    // The finished scans of the files read, to keep for a later run (see `sessionReaders`).
    scanned: readers.scanned,
  };
}
