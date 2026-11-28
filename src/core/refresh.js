// Copied from herdr-session-stats (src/refresh.js).
//
// Read-only refresh of a linked session file: the tail window of the file for the card, and a
// state over the whole file for the session totals (the accumulator of the provider's `fold`),
// both handed to a provider as plain values. Runtime-neutral: the plugin passes in its runner,
// `exec(command, args, options)` (`{ code, stdout, stderr }`, src/exec.ts). Only `tail` and
// `dd` are run; neither writes, and no shell string or redirection is used.

import { parseEntries } from './providers/jsonl.js';

// The plugin refreshes its cards this often.
export const REFRESH_INTERVAL_MS = 2000;

// The worker catches up on the session files this often (src/history/catch-up.ts).
export const CATCH_UP_MS = 15 * 60 * 1000;

// The live panel asks again for a range tab this often while it is shown, and the worker runs a
// catch-up before it answers when the last one started nearly this long ago (src/worker.ts).
export const RANGE_REFRESH_MS = 60 * 1000;

// The most of a session file one refresh reads for the figures about its end. A line cut at
// the start of the window is skipped by the provider, which ignores lines that are not whole
// JSON.
export const TAIL_BYTES = 256 * 1024;

// The most of a file one read of the first scan takes: within the runner's 8 MiB output cap.
export const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

// The core uses no runtime API, TextEncoder included: the byte length of a string in UTF-8 is
// counted from its UTF-16 code units. A surrogate pair is one 4-byte character; a lone
// surrogate is 3 bytes, the U+FFFD TextEncoder would write for it.
function charBytes(text, i) {
  const unit = text.charCodeAt(i);
  if (unit < 0x80) return 1;
  if (unit < 0x800) return 2;
  const next = text.charCodeAt(i + 1);
  return unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 4 : 3;
}

export function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const length = charBytes(text, i);
    bytes += length;
    if (length === 4) i++;
  }
  return bytes;
}

// The text after its first `n` bytes, for a block that starts `n` bytes before a position that
// follows a newline; null when that is not what the text says. A block can start inside a
// character, whose rest reads as one U+FFFD per byte (1 byte each, not the 3 of a U+FFFD
// that the file holds): up to three leading ones are tried as such.
function dropBytes(text, n) {
  let strays = 0;
  while (strays < 3 && text.charCodeAt(strays) === 0xfffd) strays++;
  for (let s = 0; s <= strays; s++) {
    let bytes = s;
    let i = s;
    while (i < text.length && bytes < n) {
      const length = charBytes(text, i);
      bytes += length;
      i += length === 4 ? 2 : 1;
    }
    if (bytes === n && text.charCodeAt(i - 1) === 0x0a) return text.slice(i);
  }
  return null;
}

// What a scan of a file has covered: `state`, the provider's accumulator over the whole lines
// of the file's first bytes. While a pass is under way (`pos` is -1) those bytes are the ones
// before block `block`, and `carry` is the text read after the last newline of them, a line
// not whole yet; `skip` is the number of bytes at the start of block `block` that are covered
// already (a pass that goes on from `pos` starts in the block that holds it). Once a pass is
// done, `pos` is the number of bytes covered, which is where the last whole line ends (the next
// byte begins a line).
const newScan = () => ({ state: undefined, block: 0, skip: 0, carry: '', pos: -1 });

// The kept scans of the session files, as the plugin stores them between runs: the finished
// scans (`{ provider, machine, path, pos, readAt, ended, state }`: the provider whose `fold`
// built the state, the Orca host of the file, null for this computer, the scan's `pos`, when the
// file was last asked for and whether it is an ended sub-agent's, which the drop order of
// `encodeScans` goes by in every later run too, and the scan's `state`) under the number of the
// version that wrote them. A stored value is JSON, so a state is written in
// plain values that read back as the same state: `undefined`, `NaN` and a `Map`, which JSON
// has no word for, are written as an object whose `$` names them, and so is an object that
// has a `$` field of its own, as `fields`.
// Raise KEPT_VERSION when a provider's state changes shape: values of another number are
// ignored, so each file is scanned whole again once. It is raised by each slice of spyhop-live
// that changes a fold's state, and by spyhop-insights (5 was spyhop 0.2.0's).
export const KEPT_VERSION = 6;

// A state as plain values that JSON writes and reads back as the same state (see above); the
// history store writes a file's state with it too (src/history/store.ts).
export function encodeState(value) {
  if (value === undefined) return { $: 'undefined' };
  if (Number.isNaN(value)) return { $: 'NaN' };
  if (value instanceof Map) return { $: 'Map', entries: [...value].map((entry) => entry.map(encodeState)) };
  if (Array.isArray(value)) return value.map(encodeState);
  if (value !== null && typeof value === 'object') {
    const fields = Object.fromEntries(Object.entries(value).map(([key, field]) => [key, encodeState(field)]));
    return '$' in fields ? { $: 'fields', fields } : fields;
  }
  return value;
}

// The state `encodeState` wrote as `value`.
export function decodeState(value) {
  if (Array.isArray(value)) return value.map(decodeState);
  if (value === null || typeof value !== 'object') return value;
  if (value.$ === 'undefined') return undefined;
  if (value.$ === 'NaN') return NaN;
  if (value.$ === 'Map') return new Map(value.entries.map((entry) => entry.map(decodeState)));
  return Object.fromEntries(Object.entries(value.$ === 'fields' ? value.fields : value).map(([key, field]) => [key, decodeState(field)]));
}

// Orca refuses to store a value whose JSON is over 262144 bytes, and a storage file over 5 MiB,
// which it writes pretty-printed. So the kept scans are stored as parts, each one JSON text (a
// string, which pretty-printing leaves as it is) whose stored JSON is at most KEPT_VALUE_BYTES,
// and all of them together at most KEPT_TOTAL_BYTES, 80% of Orca's cap, a margin for the
// escaping of the strings and the file's other keys. The first part also holds how many parts
// there are. ENVELOPE_BYTES is room for a part's fields beside its scans
// (`"{\"version\":5,\"parts\":12,\"scans\":[]}"`), with margin; KEPT_TOTAL_BYTES leaves room for
// the envelopes of as many parts as Orca keeps keys.
export const KEPT_VALUE_BYTES = 262144;
export const KEPT_TOTAL_BYTES = 4194304;
const ENVELOPE_BYTES = 64;
const MAX_PARTS = 1024;
const utf8 = new TextEncoder();

// The values to store for `scans`, in order (see KEPT_VALUE_BYTES). A scan whose JSON alone
// would not fit in a part is left out. When the rest are more than KEPT_TOTAL_BYTES, scans are
// left out in this order until they fit: the ended sub-agent transcripts (a scan's `ended`), the
// one read longest ago first (its `readAt`, epoch ms), then the others, the one read longest ago
// first. A scan left out is read again whole after a restart. The states are read at once: a
// later fold changes them.
export function encodeScans(scans) {
  const texts = scans
    .map(({ provider, machine, path, pos, state, readAt = 0, ended = false }) => {
      const text = JSON.stringify({ provider, machine, path, pos, readAt, ended, state: encodeState(state) });
      // the text as a part's string holds it, and the comma before it
      return { text, readAt, ended, size: utf8.encode(JSON.stringify(text)).length - 2 + 1 };
    })
    .filter(({ size }) => ENVELOPE_BYTES + size <= KEPT_VALUE_BYTES)
    .sort((a, b) => Number(b.ended) - Number(a.ended) || a.readAt - b.readAt);
  let total = texts.reduce((sum, { size }) => sum + size, 0);
  let dropped = 0;
  while (total > KEPT_TOTAL_BYTES - ENVELOPE_BYTES * MAX_PARTS) total -= texts[dropped++].size;
  /** @type {string[][]} the scans' texts of each part */
  const groups = [[]];
  let bytes = ENVELOPE_BYTES;
  for (const { text, size } of texts.slice(dropped)) {
    if (bytes + size > KEPT_VALUE_BYTES) {
      groups.push([]);
      bytes = ENVELOPE_BYTES;
    }
    groups.at(-1).push(text);
    bytes += size;
  }
  return groups.map((group, i) => `{"version":${KEPT_VERSION},${i === 0 ? `"parts":${groups.length},` : ''}"scans":[${group.join(',')}]}`);
}

// A stored part read, or null when it is not one JSON text.
function partOf(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// How many parts the stored first part `value` of the kept scans names: 1 for a value that names
// none, or that is not a first part of this version.
export function keptPartsOf(value) {
  const part = partOf(value);
  const parts = part?.version === KEPT_VERSION ? part.parts : undefined;
  return Number.isInteger(parts) && parts >= 1 ? parts : 1;
}

const isKeptScan = (scan) =>
  scan !== null &&
  typeof scan === 'object' &&
  typeof scan.provider === 'string' &&
  (scan.machine === null || typeof scan.machine === 'string') &&
  typeof scan.path === 'string' &&
  Number.isInteger(scan.pos) &&
  scan.pos >= 0 &&
  'state' in scan;

const isKeptPart = (part) =>
  part !== null && typeof part === 'object' && part.version === KEPT_VERSION && Array.isArray(part.scans) && part.scans.every(isKeptScan);

// The kept scans the stored parts `values` hold, in order; none when they are not what
// `encodeScans` of this version gives (fewer or more parts than the first names, a value that is
// not a JSON text, another version's number, a scan that lacks a field or whose `pos` is not a
// whole number from 0 up), or when a state cannot be read back.
export function decodeScans(values) {
  const parts = values.map(partOf);
  if (values.length !== keptPartsOf(values[0]) || !parts.every(isKeptPart)) return [];
  try {
    return parts.flatMap((part) => part.scans.map((scan) => ({ ...scan, state: decodeState(scan.state) })));
  } catch {
    return [];
  }
}

// Advances `scan` over the file `path`, of `size` bytes or more, with the provider's `fold`, so
// that its state covers the file's whole lines; resolves to the scan, which is `scan` itself
// when one is given (a finished scan `{ state, pos }` will do), and whether its earlier coverage
// was dropped and the file read again from its start (`restarted`). Read as little as possible:
//
// - The first sight of a file is one read-only pass over all of it, in blocks of
//   `SCAN_CHUNK_BYTES` by `dd` (the block `skip` of size `bs`, exactly), each within the
//   runner's output cap. A block ends anywhere, so the text of one is cut at its last
//   newline, the lines before it are folded and the rest carried to the next block: no line
//   is split. A character that a block boundary cuts reads as U+FFFD at both ends of the
//   carried line;
//   that can only change text inside a JSON string, never a figure.
//   The pass ends at the first short block. `dd` reports the bytes it copied (the number at
//   the start of its statistics line, whatever the language of the line), which is the exact
//   length of the block; the covered bytes end where the carried line begins. A line with no
//   newline yet that ends in a cut character is measured too long, so `pos` falls short; the
//   check below finds that out and the file is scanned again, which is safe, and the line is
//   whole at a later read.
// - Afterwards only what was appended: `tail -c +<pos>` starts at the last covered byte, a
//   newline, so the text after it begins a line, and its whole lines are folded; `pos`
//   advances by their UTF-8 length. A line being written is left for the next read, when
//   it is whole. Starting one byte early checks the bookkeeping: anything but a newline
//   there means the file is not what was scanned, and it is scanned again.
// - When more was appended than one read can take, the pass goes on in blocks from the one
//   that holds `pos`, dropping its bytes that are covered already.
// - A smaller file than scanned was replaced, so the scan starts over.
//
// The scan is changed in place, so a read that fails leaves it as far as it got (a block is
// folded only once read), the next read goes on from there, and the promise rejects.
export async function scanFile(exec, fold, scan, path, size) {
  let restarted = false;
  const restart = () => {
    restarted = true;
    Object.assign(scan, newScan());
  };
  scan ??= newScan();
  if (size < (scan.pos >= 0 ? scan.pos : scan.block * SCAN_CHUNK_BYTES) || scan.pos === 0) restart();
  if (scan.pos >= 0) {
    if (size === scan.pos) return { scan, restarted };
    if (size - scan.pos > SCAN_CHUNK_BYTES) {
      scan.block = Math.floor(scan.pos / SCAN_CHUNK_BYTES);
      scan.skip = scan.pos - scan.block * SCAN_CHUNK_BYTES;
      scan.carry = '';
      scan.pos = -1;
    } else {
      const added = await exec('tail', ['-c', `+${scan.pos}`, '--', path]);
      if (added.code !== 0) throw new Error(`tail failed on ${path}`);
      if (added.stdout.startsWith('\n')) {
        const rest = added.stdout.slice(1);
        const whole = rest.slice(0, rest.lastIndexOf('\n') + 1);
        scan.state = fold(scan.state, parseEntries(whole));
        scan.pos += utf8Length(whole);
        return { scan, restarted };
      }
      restart();
    }
  }
  while (scan.pos < 0) {
    const block = await exec('dd', [`if=${path}`, `bs=${SCAN_CHUNK_BYTES}`, `skip=${scan.block}`, 'count=1']);
    const copied = /^(\d+) \S/m.exec(block.stderr ?? '');
    if (block.code !== 0 || !copied) throw new Error(`dd failed on ${path}`);
    let blockText = block.stdout;
    if (scan.skip > 0) {
      blockText = dropBytes(blockText, scan.skip);
      if (blockText === null) {
        // not the file that was scanned
        restart();
        continue;
      }
      scan.skip = 0;
    }
    const text = scan.carry + blockText;
    const cut = text.lastIndexOf('\n') + 1;
    scan.state = fold(scan.state, parseEntries(text.slice(0, cut)));
    scan.carry = text.slice(cut);
    const length = Number(copied[1]);
    if (length < SCAN_CHUNK_BYTES) {
      scan.pos = scan.block * SCAN_CHUNK_BYTES + length - utf8Length(scan.carry);
      scan.carry = '';
    }
    scan.block += 1;
  }
  return { scan, restarted };
}

// `exec`: the plugin's runner. `fold(state, entries)`: the provider's accumulator (see
// src/core/providers/omp.js). `read(file)` takes `{ path, mtimeMs, size }` of a linked session file
// and resolves to the `input` of `readStats(harness, input, now)`: `{ text, sources, state }`
// with the tail window as `text`. A file that `tail` finds shorter than the window (not what
// the listing's size says, since a file grows) is read whole by it, so `sources.wholeFile` is
// true and the provider folds the text; a larger one gets a `state`
// over the whole file (see `advance`), or `null` when it could not be built, so that every
// figure of the session totals reads n/a and is tried again at the next refresh. A tail
// that cannot be read gives an empty text, so the figures about the end of the file read n/a
// for that refresh; the scan of a large file is kept, and so are its totals. A file is not
// read again while its size and modified time are those of its last read, when neither the tail
// nor the scan of that read failed: that read is the input.
//
// `kept`: the finished scans an earlier run kept (`{ path, pos, state, readAt }` each), which the
// scans of those files start from; the reader owns their states from then on. `scanned()` is
// what a later run can be given as `kept`: `{ changed, scans }`, the finished scans of the
// files read by this reader and the kept scans of the files it has not read, each with `readAt`,
// when its file was last asked for (epoch ms, in this run or the one that kept it), and whether
// any of them changed since `scanned()` was last asked. A kept scan not read is still a finished
// scan of its file, so a run keeps what earlier runs scanned of files it never reads. Their
// states are the reader's own, which a later read changes.
export function createSessionReader({ exec, fold, kept = [] }) {
  // path -> the scan of that file
  const scans = new Map();
  // path -> the kept scan of a file not read yet
  const keptScans = new Map(kept.map((scan) => [scan.path, scan]));
  // whether a finished scan changed since `scanned()` was last asked
  let changed = false;
  // path -> the last scan step of that file: agents of one file ask at once, and two steps on
  // one scan would fold the same bytes twice
  const queues = new Map();
  // path -> { mtimeMs, size, input }: the last read of that file, kept when neither its tail nor
  // its scan failed
  const reads = new Map();
  // path -> when that file was last asked for (epoch ms), which `encodeScans` drops by
  const readAt = new Map();

  // The state of the file's first `size` bytes or more (see `scanFile`). A file with a kept scan
  // and none yet starts from the kept one, as if this reader had scanned it: the checks of
  // `scanFile` tell when it is not the file that was scanned. A finished scan changes when its
  // pass ends or its `pos` moves.
  async function advance(path, size) {
    let scan = scans.get(path);
    const keptScan = keptScans.get(path);
    if (!scan && keptScan) {
      scan = { ...newScan(), state: keptScan.state, pos: keptScan.pos };
      keptScans.delete(path);
    }
    scan ??= newScan();
    scans.set(path, scan);
    const { pos } = scan;
    const { restarted } = await scanFile(exec, fold, scan, path, size);
    if (restarted || scan.pos !== pos) changed = true;
    return scan.state;
  }

  const queued = (path, work) => {
    const next = (queues.get(path) ?? Promise.resolve()).then(work);
    queues.set(path, next.catch(() => {}));
    return next;
  };

  return {
    async read(file) {
      readAt.set(file.path, Date.now());
      const last = reads.get(file.path);
      if (last?.mtimeMs === file.mtimeMs && last.size === file.size) return last.input;
      // a tail that cannot be read, or cannot be started, is an empty text
      const tail = await exec('tail', ['-c', String(TAIL_BYTES), '--', file.path]).catch(() => ({ code: -1 }));
      const text = tail.code === 0 ? tail.stdout : '';
      // The file is whole in the text when `tail` gave less than the window: that is what the
      // file held when it was read, whatever the listing's size said (the file can grow between
      // the two). A string of fewer UTF-16 units than the window can still be longer in bytes,
      // so the exact length is counted only for those.
      const whole = tail.code === 0 && text.length < TAIL_BYTES && utf8Length(text) < TAIL_BYTES;
      let input;
      // a tail that failed on a file the listing says fits is not tried again with a scan
      if (whole || (tail.code !== 0 && file.size <= TAIL_BYTES)) {
        if (scans.delete(file.path)) changed = true;
        if (keptScans.delete(file.path)) changed = true;
        input = whole ? { text, sources: { wholeFile: true } } : { text, sources: {} };
      } else {
        const state = await queued(file.path, () => advance(file.path, file.size)).catch(() => null);
        input = { text, sources: {}, state };
      }
      if (tail.code === 0 && input.state !== null) reads.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, input });
      else reads.delete(file.path);
      return input;
    },

    scanned() {
      const finished = [];
      for (const [path, { pos, state }] of scans) if (pos >= 0) finished.push({ path, pos, state, readAt: readAt.get(path) ?? 0 });
      for (const { path, pos, state, readAt: keptAt = 0 } of keptScans.values()) finished.push({ path, pos, state, readAt: keptAt });
      const was = changed;
      changed = false;
      return { changed: was, scans: finished };
    },
  };
}
