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

function utf8Length(text) {
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

// `exec`: the plugin's runner. `fold(state, entries)`: the provider's accumulator (see
// src/core/providers/omp.js). `read(file)` takes `{ path, mtimeMs, size }` of a linked session file
// and resolves to the `input` of `readStats(harness, input, now)`: `{ text, sources, state }`
// with the tail window as `text`. A file that `tail` finds shorter than the window (not what
// the listing's size says, since a file grows) is read whole by it, so `sources.wholeFile` is
// true and the provider folds the text; a larger one gets a `state`
// over the whole file (see `advance`), or `null` when it could not be built, so that every
// figure of the session totals reads n/a and is tried again at the next refresh. A tail
// that cannot be read gives an empty text, so the figures about the end of the file read n/a
// for that refresh; the scan of a large file is kept, and so are its totals.
export function createSessionReader({ exec, fold }) {
  // path -> the scan of that file
  const scans = new Map();
  // path -> the last scan step of that file: agents of one file ask at once, and two steps on
  // one scan would fold the same bytes twice
  const queues = new Map();

  // The state of the file's first `size` bytes or more, read as little as possible:
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
  //   whole at a later refresh.
  // - Afterwards only what was appended: `tail -c +<pos>` starts at the last covered byte, a
  //   newline, so the text after it begins a line, and its whole lines are folded; `pos`
  //   advances by their UTF-8 length. A line being written is left for the next refresh, when
  //   it is whole. Starting one byte early checks the bookkeeping: anything but a newline
  //   there means the file is not what was scanned, and it is scanned again.
  // - When more was appended than one read can take, the pass goes on in blocks from the one
  //   that holds `pos`, dropping its bytes that are covered already.
  // - A smaller file than scanned was replaced, so the scan starts over.
  //
  // A read that fails leaves the scan as it was (a block is folded only once read), so the next
  // refresh goes on from there, and throws.
  async function advance(path, size) {
    let scan = scans.get(path);
    if (scan && (size < (scan.pos >= 0 ? scan.pos : scan.block * SCAN_CHUNK_BYTES) || scan.pos === 0)) scan = undefined;
    if (scan?.pos >= 0) {
      if (size === scan.pos) return scan.state;
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
          return scan.state;
        }
        scan = undefined;
      }
    }
    if (!scan) {
      scan = newScan();
      scans.set(path, scan);
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
          scan = newScan();
          scans.set(path, scan);
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
    return scan.state;
  }

  const queued = (path, work) => {
    const next = (queues.get(path) ?? Promise.resolve()).then(work);
    queues.set(path, next.catch(() => {}));
    return next;
  };

  return {
    async read(file) {
      // a tail that cannot be read, or cannot be started, is an empty text
      const tail = await exec('tail', ['-c', String(TAIL_BYTES), '--', file.path]).catch(() => ({ code: -1 }));
      const text = tail.code === 0 ? tail.stdout : '';
      // The file is whole in the text when `tail` gave less than the window: that is what the
      // file held when it was read, whatever the listing's size said (the file can grow between
      // the two). A string of fewer UTF-16 units than the window can still be longer in bytes,
      // so the exact length is counted only for those.
      const whole = tail.code === 0 && text.length < TAIL_BYTES && utf8Length(text) < TAIL_BYTES;
      // a tail that failed on a file the listing says fits is not tried again with a scan
      if (whole || (tail.code !== 0 && file.size <= TAIL_BYTES)) {
        scans.delete(file.path);
        return whole ? { text, sources: { wholeFile: true } } : { text, sources: {} };
      }
      const state = await queued(file.path, () => advance(file.path, file.size)).catch(() => null);
      return { text, sources: {}, state };
    },
  };
}
