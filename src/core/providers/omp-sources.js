// Copied from herdr-session-stats (src/providers/omp-sources.js).
//
// The omp side of a card's I/O: where omp keeps a folder's sessions, the sub-agent transcripts
// of a session, and the plain values its figures need besides the session text
// (src/core/providers/omp.js reads only values handed in). It is the omp provider's
// `createSessions` hook (see the stats-shape header of src/core/providers/index.js); the card
// builder asks the registry and knows nothing of omp. Runtime-neutral: it takes the plugin's
// runner and text reader bound to an Orca host, and runs only read-only programs there: `find`
// with `stat`, `head`, `tail` and `dd` (through the session reader), and `sqlite3 -readonly`.
// omp's own CLI is not run: `omp config list` and `omp config get` write omp's agent.db and its
// natives folder when they start, so the compaction settings are read from config.yml itself.

import { createTtlCache } from '../ttl-cache.js';
import { parseEntries } from './jsonl.js';
import { compactionTrigger, endedSubAgent, ompProvider, sessionStart, turnOf } from './omp.js';
import { isNumber } from './shared.js';
import {
  SUBAGENT_DEPTH,
  absoluteFolder,
  findNamedFiles,
  listFilesOfFolders,
  listFolder,
  readOnce,
  sessionHeads,
  sessionReaders,
  subAgentReads,
  unchangedSince,
} from './session-files.js';

// Most heads one listing reads for the agents no session id named: those of the newest listed
// files whose head is not known yet or whose file changed since. It bounds what a refresh
// costs, not which sessions an agent may link to: a head once read costs nothing while its file
// is unchanged, so a workspace with years of sessions is read 32 heads per refresh, a few at a
// time (see `sessionHeads`), until every head is known, and an idle agent's old session is
// reached then.
export const HEADS_PER_LISTING = 32;

// The model catalogue and the compaction settings change rarely; they are read again after
// this long rather than at every refresh.
export const SLOW_SOURCE_TTL_MS = 60 * 1000;

// Name of omp's session folder for a working folder (herdr-session-stats
// docs/omp-session-format.md), which `end` ends: under the home folder it is the path below
// home with `/` as `-` and a `-` in front (home itself is `-`), and has no end; elsewhere it is
// the path with `/` as `-` between two dashes on each end. omp's own rule has a third case for
// folders under the system temp folder, which spyhop leaves out: an agent of such a folder
// without a session id has no linked session, so its card reads n/a.
function sessionDirName(cwd, home, end) {
  const flat = (path) => path.replace(/[/\\:]/g, '-');
  const path = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
  if (home && (path === home || path.startsWith(`${home}/`))) return `-${flat(path.slice(home.length + 1))}`;
  return `--${flat(path.replace(/^[/\\]/, ''))}${end}`;
}

// omp's session folder name for the working folder `cwd`.
export const sessionDirSlug = (cwd, home) => sessionDirName(cwd, home, '--');

// The start of that name, without the dashes that end it: the session folder of a folder below
// `cwd` starts with it, and so does that of a folder beside `cwd` whose name starts alike
// (`projects-old` beside `projects`).
const sessionDirStart = (cwd, home) => sessionDirName(cwd, home, '');

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

// Every model of each provider's newest catalogue row, `{ provider, id, contextWindow }`: the
// provider is what the row's `provider_id` names before its first `:`.
export const WINDOWS_QUERY =
  "SELECT substr(m.provider_id, 1, instr(m.provider_id || ':', ':') - 1) AS provider, json_extract(j.value, '$.id') AS id, json_extract(j.value, '$.contextWindow') AS contextWindow " +
  'FROM model_cache AS m, json_each(m.models) AS j WHERE m.updated_at = (SELECT max(n.updated_at) FROM model_cache AS n ' +
  "WHERE substr(n.provider_id, 1, instr(n.provider_id || ':', ':') - 1) = substr(m.provider_id, 1, instr(m.provider_id || ':', ':') - 1))";

// The tokens at which omp compacts on its own, by model: a function of `<provider>/<id>` to the
// tokens of `compactionTrigger` from the window `windows` (`WINDOWS_QUERY`'s rows, or null) holds
// for it and the `compaction` block `settings` of omp's config (or null); null where it cannot be
// known: an unreadable config or catalogue, a model of no window.
export function autoCompactionAt(windows, settings) {
  const known = new Map((windows ?? []).filter(({ contextWindow }) => isNumber(contextWindow) && contextWindow > 0).map(({ provider, id, contextWindow }) => [`${provider}/${id}`, contextWindow]));
  return (key) => {
    const window = known.get(key);
    return window === undefined ? null : (compactionTrigger(window, key, settings) ?? null);
  };
}

// The folder omp keeps every working folder's session folder in.
export const ompSessionsDir = (home) => `${home}/.omp/agent/sessions`;

// The title of a session, from `text`, which starts with the file's first line: omp writes the
// `title` entry there and rewrites it in place when the title changes (it always equals the
// latest `title_change` entry). '' when the line is not a title entry: the session then matches
// no agent title (see shareSessions).
export function titleIn(text) {
  const [entry] = parseEntries(text.split('\n', 1)[0]);
  return entry?.type === 'title' && typeof entry.title === 'string' ? entry.title : '';
}

// The `session` entry is one of the first lines of an omp session file: the first, or the
// second after a `title` entry.
const SESSION_ENTRY_LINES = 2;

// The folder a session records as its own, the `cwd` of its `session` entry, from `text`, which
// starts with the file's first lines; null when those hold no such entry or it names no folder
// (see `absoluteFolder`).
function recordedFolder(text) {
  const head = text.split('\n', SESSION_ENTRY_LINES).join('\n');
  const entry = parseEntries(head).find(({ type }) => type === 'session');
  return absoluteFolder(entry?.cwd);
}

// Whether `folder` is the folder `top` or one below it.
function isAtOrBelow(folder, top) {
  const base = top.replace(/\/+$/, '');
  return folder === base || folder.startsWith(`${base}/`);
}

// The `session_init` entry of a sub-agent transcript follows its `title`, `session` and
// `model_change` entries, so its first lines hold it; a running sub-agent's task is read from
// them, at most TASK_CHARS characters of its first line.
const TASK_LINES = 6;
const TASK_CHARS = 120;

// The task of a sub-agent, from `text`, the first lines of its transcript: the first line of
// the `task` its `session_init` entry records, cut to TASK_CHARS characters; null when those
// lines hold no such entry.
function taskIn(text) {
  const init = parseEntries(text).find(({ type }) => type === 'session_init');
  return typeof init?.task === 'string' ? init.task.split('\n', 1)[0].slice(0, TASK_CHARS) : null;
}

// The sub-agents of a session among `listed`, the `.jsonl` files in its sub-agent `folder` (the
// session file's path without `.jsonl`) and below it, each a listed transcript with its `name`.
// omp writes a sub-agent's transcript as `<F>/<Name>.jsonl`, where `F` is the session's folder,
// or the folder `<P>/<X>` of the sub-agent whose transcript is `<P>/<X>.jsonl`, for a sub-agent
// that one started. `changes.jsonl` is omp's edit log, no transcript; any other `.jsonl` file is
// none either, as in a folder of tool output. The lock file `.<Name>.jsonl.lock.os` omp keeps
// beside a transcript tells nothing of whether it runs: omp leaves it behind once the sub-agent
// has ended.
function subAgentsIn(folder, listed) {
  const paths = new Set(listed.map(({ path }) => path));
  const parts = (path) => {
    const at = path.lastIndexOf('/');
    return { parent: path.slice(0, at), name: path.slice(at + 1, -'.jsonl'.length) };
  };
  const isSubAgent = (path) => {
    if (!path.endsWith('.jsonl')) return false;
    const { parent, name } = parts(path);
    return name !== 'changes' && (parent === folder || (paths.has(`${parent}.jsonl`) && isSubAgent(`${parent}.jsonl`)));
  };
  return listed.filter(({ path }) => isSubAgent(path)).map((file) => ({ ...file, name: parts(file.path).name }));
}

// Whether a sub-agent runs, from `turn`, the turn of its transcript (see `turnOf`), and
// `started`, the start of its session: while its turn is open, unless its newest entry is
// older than the session, as in a transcript omp copied beside the file of a session it
// continued. Null, which the counts read as n/a, when the transcript is not known whole, or its
// turn is open and either time is not known.
export function runs(turn, started) {
  if (!turn) return null;
  if (!turn.open) return false;
  return turn.last === null || started === null ? null : turn.last >= started;
}

// `execOn(machine)` and `readTextOn(machine)`: the plugin's runner and text reader bound to an
// Orca host (null: this computer). State kept between calls (the
// per-machine session readers, the slow sources) lives in the returned object. `kept`: the
// scans of omp session files an earlier run kept (see `sessionReaders`).
export function createOmpSessions({ execOn, readTextOn, kept }) {
  // each machine's reader, which keeps that machine's per-file totals
  const readers = sessionReaders(execOn, ompProvider.fold, kept);

  // What the head of each session file told (see `sessionHeads`): its title (see titleIn) and
  // the folder it records (see recordedFolder).
  const heads = sessionHeads(execOn, {
    head: ['-n', String(SESSION_ENTRY_LINES)],
    tells: (text) => ({ title: titleIn(text), cwd: recordedFolder(text) }),
  });

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

  // the sub-agent transcripts read through `readers` (see `subAgentReads`)
  const subAgentInputs = subAgentReads(readers);
  // The turn of each sub-agent transcript read (see `turnOf`), by its read's `input`: the reader
  // gives the same `input` again for a transcript unchanged since, so a transcript read whole
  // is folded for its turn once per change, not at each refresh.
  const turns = new WeakMap();
  const turnIn = (input) => {
    if (!turns.has(input)) turns.set(input, turnOf(input));
    return turns.get(input);
  };
  // host, NUL, path -> the start of the session of each session file read (see `sessionStart`),
  // as its last read told it: a file's sub-agents are asked for after its read
  const starts = new Map();
  // The task the head of a running sub-agent's transcript told (see `taskIn`): read once, and
  // again only after a read that failed; kept in memory only.
  const taskOf = readOnce(async (machine, path) => {
    const { code, stdout } = await execOn(machine)('head', ['-n', String(TASK_LINES), '--', path]);
    if (code !== 0) throw new Error(`head failed on ${path}`);
    return taskIn(stdout);
  });

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
      const where = { dir: ompSessionsDir(home), os, depth: 2, pattern: (id) => `*_${id}.jsonl` };
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
      const listed = await listFilesOfFolders(execOn(machine), { dir: ompSessionsDir(home), os, prefix: sessionDirStart(cwd, home) });
      let reads = 0;
      const found = await Promise.all(
        listed
          .filter((file) => !except.includes(file.path))
          .map(async (file) => {
            const hit = heads.last(machine, file);
            const settled = hit && (unchangedSince(hit, file) || (hit.cwd !== null && !isAtOrBelow(hit.cwd, cwd)));
            if (settled || reads >= HEADS_PER_LISTING) return { file, head: hit };
            reads += 1;
            return { file, head: await heads.of(machine, file) };
          }),
      );
      return found.filter(({ head }) => head?.cwd && isAtOrBelow(head.cwd, cwd)).map(({ file, head }) => ({ ...file, title: head.title }));
    },

    // The `input` of `readStats('omp', input, now)` for a linked file. A file that is whole in
    // the text read also tells the folder it records, for `folder`; the read tells the start of
    // the session, for `subagents`.
    async read(file, { machine, home, now }) {
      const input = await readers.on(machine).read(file);
      const { text, sources, state } = input;
      if (sources.wholeFile) heads.learn(machine, file, text);
      starts.set(`${machine ?? ''}\0${file.path}`, sessionStart(input));
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
    folder(file, { machine }) {
      return heads.folder(machine, file);
    },

    // The sub-agents of the session of a linked file (see `subAgentsIn`), from one listing of
    // the folder beside it, each with its `input` (see `subAgentReads`) and whether it runs (see
    // `runs`), from that read and the start the session file's read told: a transcript not read
    // yet has no running mark. The kind and the model are the transcript's own (`detail` of its
    // stats), so they are null here; a running sub-agent's task is read from its head once. A
    // session without the folder has none; a listing that fails otherwise rejects, since its
    // sub-agents are then unknown, not none.
    async subagents(file, { machine, os }) {
      const folder = file.path.replace(/\.jsonl$/, '');
      const listed = subAgentsIn(folder, await listFolder(execOn(machine), { dir: folder, os, depth: SUBAGENT_DEPTH, names: ['*.jsonl'], strict: true }));
      const inputs = subAgentInputs.inputs(machine, listed);
      const started = starts.get(`${machine ?? ''}\0${file.path}`) ?? null;
      return Promise.all(
        listed.map(async ({ name, path }, i) => {
          const input = await inputs[i];
          const running = input === null ? null : runs(turnIn(input), started);
          const task = running ? await taskOf(machine, path) : null;
          return { name, kind: null, model: null, task, running, input };
        }),
      );
    },

    // The finished scans of the files read, to keep for a later run (see `sessionReaders`), each
    // with whether it is an ended sub-agent's, which `encodeScans` drops first.
    scanned() {
      const { changed, scans } = readers.scanned();
      return { changed, scans: scans.map((scan) => ({ ...scan, ended: endedSubAgent(scan.state) })) };
    },
  };
}
