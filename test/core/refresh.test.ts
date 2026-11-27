import { describe, test } from 'node:test';
import { NA, readStats } from '../../src/core/providers/index.js';
import { ompProvider } from '../../src/core/providers/omp.js';
import { KEPT_TOTAL_BYTES, KEPT_VALUE_BYTES, REFRESH_INTERVAL_MS, SCAN_CHUNK_BYTES, TAIL_BYTES, createSessionReader, decodeScans, encodeScans, keptPartsOf } from '../../src/core/refresh.js';
import { NOW, OMP_PATH as PATH, sessionFile } from './helpers/entries.ts';
import { expect } from './helpers/expect.ts';
import { localExec } from './helpers/local-exec.ts';

const message = (role, minute, extra = {}) =>
  JSON.stringify({
    type: 'message',
    id: `m${minute}`,
    timestamp: new Date(NOW - 60 * 60_000 + minute * 60_000).toISOString(),
    message: { role, provider: 'p', model: 'tail-model', content: 'x'.repeat(2000), ...extra },
  });
const compaction = (id) => JSON.stringify({ type: 'compaction', id, summary: 's', tokensBefore: 1, tokensAfter: 1 });

// A session several times the tail window: its header and first compaction are far out of the
// tail's reach, the second compaction and the latest model inside it.
function bigSession() {
  const lines = [JSON.stringify({ type: 'session', id: 's', timestamp: new Date(NOW - 60 * 60_000).toISOString() })];
  lines.push(compaction('c1'));
  for (let i = 0; lines.join('\n').length < TAIL_BYTES * 4; i++) lines.push(message('user', i % 50));
  lines.push(compaction('c2'));
  lines.push(message('user', 51), message('assistant', 52));
  return `${lines.join('\n')}\n`;
}

// A session a little over one scan block, whose first block ends two bytes into a 4-byte
// character of its third line, with a compaction at the start and one at the end.
function cutSession() {
  const head = [JSON.stringify({ type: 'session', id: 's', timestamp: new Date(NOW - 60 * 60_000).toISOString() }), compaction('c1')];
  const note = '{"type":"custom","note":"';
  const prefix = Buffer.byteLength(head.join('\n')) + 1;
  const lines = [...head, `${note}${'n'.repeat(SCAN_CHUNK_BYTES - 2 - prefix - note.length)}😀"}`];
  let size = SCAN_CHUNK_BYTES;
  for (let i = 0; size < SCAN_CHUNK_BYTES + 200_000; i++) {
    lines.push(message('user', i % 50));
    size += lines.at(-1).length + 1;
  }
  lines.push(compaction('c2'));
  return `${lines.join('\n')}\n`;
}

const file = (text, mtimeMs = 1000) => sessionFile(text, PATH, mtimeMs);
const newReader = (exec) => createSessionReader({ exec, fold: ompProvider.fold });
// the autocompactions of a read, which is what the whole-file count shows as
const counted = async (reader, f) => readStats('omp', await reader.read(f), NOW).autocompactions;

describe('refresh', () => {
  test('interval is 2 seconds', () => {
    expect(REFRESH_INTERVAL_MS).toBe(2000);
  });

  test('reads only the tail window', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec, calls, served } = localExec(files);
    const reader = newReader(exec);
    await reader.read(file(text)); // the one-off first scan is not a refresh of this scenario

    // a refresh of a file far larger than the window, with lines appended: the tail, plus the
    // appended bytes (and the newline before them, which checks where they begin), and never
    // the whole file
    const appended = `${compaction('c3')}\n${message('assistant', 53)}\n`;
    text += appended;
    files.set(PATH, text);
    const mark = calls.length;
    const input = await reader.read(file(text, 2000));

    expect(text.length).toBeGreaterThan(TAIL_BYTES * 3);
    expect(input.text.length).toBeLessThanOrEqual(TAIL_BYTES);
    expect(text.endsWith(input.text)).toBe(true);
    expect(calls[mark]).toMatchObject({ command: 'tail', args: ['-c', String(TAIL_BYTES), '--', PATH] });
    expect(served(mark)).toBeLessThanOrEqual(TAIL_BYTES + appended.length + 1);
  });

  test('the first refresh counts the whole file once', async () => {
    const text = bigSession();
    const { exec, calls } = localExec(new Map([[PATH, text]]));
    const reader = newReader(exec);
    const stats = readStats('omp', await reader.read(file(text)), NOW);

    // the second compaction is in the tail, the first only in the whole-file state
    expect(stats.model).toBe('tail-model');
    expect(stats.autocompactions).toBe(2);

    // a file of the same size is counted from the state: no more than the tail is served
    const mark = calls.length;
    expect(await counted(reader, file(text, 2000))).toBe(2);
    expect(calls.slice(mark).map((call) => call.command)).toEqual(['tail']);
  });

  test('appended compactions are added to the count', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec } = localExec(files);
    const reader = newReader(exec);
    await reader.read(file(text));

    text += `${compaction('c3')}\n${message('assistant', 53)}\n`;
    files.set(PATH, text);
    expect(await counted(reader, file(text, 2000))).toBe(3);
  });

  test('a line appended after the listing is not counted twice', async () => {
    const listed = bigSession();
    const grown = `${listed}${compaction('c3')}\n`;
    const files = new Map([[PATH, listed]]);
    // the file grows between the lister's stat and the scan
    const { exec } = localExec(files, { before: (call) => call.command === 'dd' && files.set(PATH, grown) });
    const reader = newReader(exec);

    // the scan reads what is there, the new line included; the next refresh starts after it
    expect(await counted(reader, file(listed))).toBe(3);
    expect(await counted(reader, file(grown, 2000))).toBe(3);
  });

  test('a file that grows past the window between the listing and the tail is not read as whole', async () => {
    const grown = bigSession();
    // what the listing saw: the header, the first compaction and a few messages
    const listed = `${grown.split('\n').slice(0, 12).join('\n')}\n`;
    expect(Buffer.byteLength(listed)).toBeLessThanOrEqual(TAIL_BYTES);
    const files = new Map([[PATH, listed]]);
    // the file grows after the lister's `stat`, before the tail is read
    const { exec } = localExec(files, { before: (call) => call.command === 'tail' && call.args[1] === String(TAIL_BYTES) && files.set(PATH, grown) });
    const input = await newReader(exec).read(file(listed));

    // the tail is only the end of the file, so it is not the whole file; the totals come from
    // the scan, and the first compaction, far out of the tail's reach, is counted
    expect(input.sources.wholeFile).toBeUndefined();
    expect(input.state).not.toBeNull();
    expect(readStats('omp', input, NOW).autocompactions).toBe(2);
  });

  test('a file within the window is read whole', async () => {
    const small = `${bigSession().split('\n').slice(0, 12).join('\n')}\n`;
    const { exec, calls } = localExec(new Map([[PATH, small]]));
    const input = await newReader(exec).read(file(small));

    expect(input.sources).toEqual({ wholeFile: true });
    expect(readStats('omp', input, NOW).autocompactions).toBe(1);
    expect(calls.map((call) => call.command)).toEqual(['tail']);
  });

  test('a failed incremental read goes on from where the scan stood', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const faults = {};
    const { exec, calls } = localExec(files, faults);
    const reader = newReader(exec);
    await reader.read(file(text));

    text += `${compaction('c3')}\n`;
    files.set(PATH, text);
    faults.fail = (call) => call.command === 'tail' && call.args[1].startsWith('+');
    const failed = await reader.read(file(text, 2000));
    expect(failed.state).toBe(null);
    expect(readStats('omp', failed, NOW).autocompactions).toBe(NA);
    // the tail still gives the figures about the end of the file
    expect(readStats('omp', failed, NOW).model).toBe('tail-model');

    // nothing was folded from the failed read, so the next refresh goes on from where the
    // scan stood: the count is whole again without reading the file a second time
    faults.fail = null;
    const scans = () => calls.filter((call) => call.command === 'dd').length;
    const before = scans();
    expect(await counted(reader, file(text, 3000))).toBe(3);
    expect(scans()).toBe(before);
  });

  test('a dd that did not exit is not a count of 0', async () => {
    const text = bigSession();
    const faults = { fail: (call) => call.command === 'dd' };
    const { exec, calls } = localExec(new Map([[PATH, text]]), faults);
    const reader = newReader(exec);

    const failed = await reader.read(file(text));
    expect(failed.state).toBe(null);
    expect(readStats('omp', failed, NOW).autocompactions).toBe(NA);
    expect(readStats('omp', failed, NOW).totalTokens).toBe(NA);

    // nothing was kept: the next refresh scans the file again
    faults.fail = null;
    expect(await counted(reader, file(text))).toBe(2);
    expect(calls.filter((call) => call.command === 'dd')).toHaveLength(2);
  });

  test('a scan whose dd does not say how much it copied is no state', async () => {
    const text = bigSession();
    const { exec } = localExec(new Map([[PATH, text]]), { ddReport: 'none' });
    const input = await newReader(exec).read(file(text));

    expect(input.state).toBe(null);
    expect(readStats('omp', input, NOW).autocompactions).toBe(NA);
  });

  test("dd's report is read whatever its wording or the size of the block", async () => {
    const text = bigSession();
    const wordings = [
      (n) => `${n} Bytes (${n} B) copiert, 0,001 s, 1,0 MB/s`,
      (n) => `${n} octets (${n} o) copiés, 0,001 s, 1,0 Mo/s`,
      (n) => (n === 1 ? '1 byte copied, 0.001 s, 1.0 kB/s' : `${n} bytes copied, 0.001 s, 1.0 kB/s`),
      // BSD (macOS) dd
      (n) => `${n} bytes transferred in 0.001 secs (${n * 1000} bytes/sec)`,
    ];
    for (const ddReport of wordings) {
      const { exec } = localExec(new Map([[PATH, text]]), { ddReport });
      expect(await counted(newReader(exec), file(text))).toBe(2);
    }

    // a last block of one byte: the file is one chunk and a newline long
    const bytes = Buffer.concat([Buffer.from(text), Buffer.from('\n'.repeat(SCAN_CHUNK_BYTES + 1 - Buffer.byteLength(text)))]);
    expect(bytes.length).toBe(SCAN_CHUNK_BYTES + 1);
    const { exec, calls } = localExec(new Map([[PATH, bytes]]), { ddReport: wordings[2] });
    expect(await counted(newReader(exec), { path: PATH, mtimeMs: 1000, size: bytes.length })).toBe(2);
    expect(calls.filter((call) => call.command === 'dd')).toHaveLength(2);
  });

  test('a tail that cannot be read keeps the totals of the scan', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const faults = {};
    const { exec, calls } = localExec(files, faults);
    const reader = newReader(exec);
    await reader.read(file(text));

    text += `${compaction('c3')}\n`;
    files.set(PATH, text);
    faults.fail = (call) => call.command === 'tail' && call.args[1] === String(TAIL_BYTES);
    const stats = readStats('omp', await reader.read(file(text, 2000)), NOW);
    // the figures about the end of the file are n/a for this refresh, the totals are not lost
    expect(stats.model).toBe(NA);
    expect(stats.autocompactions).toBe(3);

    faults.fail = null;
    expect(await counted(reader, file(text, 3000))).toBe(3);
    expect(calls.filter((call) => call.command === 'dd')).toHaveLength(1);
  });

  test('more appended than one read takes goes on in blocks from where the scan ended', async () => {
    // a character of the first line cut by the first block, so the block that holds the end of
    // the scan starts inside one
    const session = cutSession();
    const bytes0 = Buffer.from(session);
    expect(bytes0[SCAN_CHUNK_BYTES] & 0xc0).toBe(0x80);
    const files = new Map([[PATH, bytes0]]);
    const { exec, calls } = localExec(files);
    const reader = newReader(exec);
    expect(await counted(reader, file(session))).toBe(2);

    // over a chunk appended, with a compaction at each end
    const appended = `${compaction('c3')}\n${`${message('user', 3)}\n`.repeat(Math.ceil((SCAN_CHUNK_BYTES + 100_000) / 2100))}${compaction('c4')}\n`;
    const grown = Buffer.concat([bytes0, Buffer.from(appended)]);
    files.set(PATH, grown);
    const mark = calls.length;
    expect(await counted(reader, { path: PATH, mtimeMs: 2000, size: grown.length })).toBe(4);
    // not from the start: from the block that holds the end of the first scan
    const blocks = calls.slice(mark).filter((call) => call.command === 'dd').map((call) => call.args[2]);
    expect(blocks).toEqual(['skip=1', 'skip=2']);
  });

  test('a last line cut inside a character is counted once it is whole', async () => {
    // the unfinished line is measured too long, so the position of the scan is off and the next
    // read finds that out and scans again: the count is right either way
    const whole = Buffer.from(`${JSON.stringify({ type: 'compaction', id: 'c3', summary: 'é' })}\n`);
    const cut = whole.indexOf(0xc3) + 1;
    const base = Buffer.from(bigSession());
    const files = new Map([[PATH, Buffer.concat([base, whole.subarray(0, cut)])]]);
    const { exec } = localExec(files);
    const reader = newReader(exec);
    expect(await counted(reader, { path: PATH, mtimeMs: 1000, size: base.length + cut })).toBe(2);

    files.set(PATH, Buffer.concat([base, whole]));
    expect(await counted(reader, { path: PATH, mtimeMs: 2000, size: base.length + whole.length })).toBe(3);
  });

  test('a half-written line is counted once it is whole', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec } = localExec(files);
    const reader = newReader(exec);
    await reader.read(file(text));

    const whole = `${compaction('c3')}\n`;
    text += whole.slice(0, 20);
    files.set(PATH, text);
    expect(await counted(reader, file(text, 2000))).toBe(2);
    // the cut line already holds the matched text; it must not count before its newline
    text += whole.slice(20);
    files.set(PATH, text);
    expect(await counted(reader, file(text, 3000))).toBe(3);
  });

  test('the scanned size advances by UTF-8 bytes, not characters', async () => {
    // the files are byte-accurate Buffers, `tail -c +N` starts at byte N and `dd` reports bytes,
    // as the real programs do
    let bytes = Buffer.from(bigSession());
    const files = new Map([[PATH, bytes]]);
    const { exec, calls } = localExec(files);
    const reader = newReader(exec);
    const listed = () => ({ path: PATH, mtimeMs: 1000, size: bytes.length });
    expect(await counted(reader, listed())).toBe(2);

    // é is 2 bytes, 漢 is 3, 😀 is 4 (two UTF-16 units): each appended line is longer in bytes
    // than in characters, and a wrong advance would start the next read inside the last line
    // and count it again
    for (const [n, id] of ['c3', 'c4', 'c5'].entries()) {
      bytes = Buffer.concat([bytes, Buffer.from(`${JSON.stringify({ type: 'compaction', id, summary: 'é漢😀'.repeat(10) })}\n`)]);
      files.set(PATH, bytes);
      expect(await counted(reader, listed())).toBe(3 + n);
    }
    // never scanned again: the advance stayed right
    expect(calls.filter((call) => call.command === 'dd')).toHaveLength(1);
  });

  test('a replaced, smaller file is counted from its start', async () => {
    const text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec } = localExec(files);
    const reader = newReader(exec);
    await reader.read(file(text));

    const replaced = `${message('user', 2)}\n`.repeat(200);
    expect(replaced.length).toBeGreaterThan(TAIL_BYTES);
    expect(replaced.length).toBeLessThan(text.length);
    files.set(PATH, replaced);
    expect(await counted(reader, file(replaced, 5000))).toBe(0);
  });

  test('a file that is not what was scanned is scanned again', async () => {
    const text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec, calls } = localExec(files);
    const reader = newReader(exec);
    await reader.read(file(text));

    // a larger file whose byte before the scanned size is not a newline: one line of 'y'
    // as long as the old file, then a compaction
    const replaced = `${'y'.repeat(text.length)}\n${compaction('o3')}\n`;
    files.set(PATH, replaced);
    const mark = calls.length;
    expect(await counted(reader, file(replaced, 5000))).toBe(1);
    expect(calls.slice(mark).some((call) => call.command === 'dd')).toBe(true);
  });

  test('a kept scan is dropped by a file seen whole in the tail', async () => {
    const scanned = bigSession();
    const files = new Map([[PATH, scanned]]);
    const { exec, calls } = localExec(files);
    const earlier = newReader(exec);
    await earlier.read(file(scanned));
    const kept = earlier.scanned().scans;
    expect(kept.map((scan) => scan.pos)).toEqual([scanned.length]);

    // another session at that path, within the window
    const small = `${compaction('n1')}\n`;
    files.set(PATH, small);
    const reader = createSessionReader({ exec, fold: ompProvider.fold, kept });
    expect((await reader.read(file(small, 2000))).sources).toEqual({ wholeFile: true });
    // the dropped scan is a change to write, and the scans to write no longer hold the path
    expect(reader.scanned()).toEqual({ changed: true, scans: [] });

    // it grows past the kept position, with a newline as the byte before it: a line that ends
    // where the scanned file did, then a compaction
    const note = (length) => `${JSON.stringify({ type: 'custom', note: 'y'.repeat(length) })}\n`;
    const grown = `${small}${note(scanned.length - small.length - note(0).length)}${compaction('n2')}\n`;
    expect(grown[scanned.length - 1]).toBe('\n');
    files.set(PATH, grown);
    const mark = calls.length;
    // the two compactions of the file, not the kept scan's two and the appended one
    expect(await counted(reader, file(grown, 3000))).toBe(2);
    const blocks = calls.slice(mark).filter((call) => call.command === 'dd').map((call) => call.args[2]);
    expect(blocks).toEqual(['skip=0']);
  });

  test('Orca agents of one file asking at once fold its lines once', async () => {
    const text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec } = localExec(files);
    const reader = newReader(exec);
    await reader.read(file(text));

    const grown = `${text}${compaction('c3')}\n`;
    files.set(PATH, grown);
    const reads = await Promise.all([reader.read(file(grown, 2000)), reader.read(file(grown, 2000)), reader.read(file(grown, 2000))]);
    for (const input of reads) expect(readStats('omp', input, NOW).autocompactions).toBe(3);
  });

  test('a file within the tail window is not counted', async () => {
    const text = `${JSON.stringify({ type: 'session', id: 's' })}\n${compaction('c1')}\n${message('assistant', 1)}\n`;
    const { exec, calls } = localExec(new Map([[PATH, text]]));
    const input = await newReader(exec).read(file(text));

    expect(calls.map((call) => call.command)).toEqual(['tail']);
    expect(readStats('omp', input, NOW).autocompactions).toBe(1);
  });

  test('a first scan takes blocks within the chunk size', () => {
    expect(SCAN_CHUNK_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  test('no writes', async () => {
    let text = bigSession();
    const files = new Map([[PATH, text]]);
    const { exec, calls } = localExec(files);
    const reader = newReader(exec);
    await reader.read(file(text));
    text += `${compaction('c3')}\n`;
    files.set(PATH, text);
    await reader.read(file(text, 2000));

    expect(calls.length).toBeGreaterThan(2);
    for (const { command, args } of calls) {
      expect(['tail', 'dd']).toContain(command);
      // no redirection, no output operand or flag
      expect(args.filter((arg) => /^\d*>|^of=|^-i|^--in-place|^--output/.test(arg))).toEqual([]);
      // the path follows `--`, or is the `if=` operand of dd
      if (command === 'tail') expect(args.at(-2)).toBe('--');
      else expect(args[0]).toBe(`if=${PATH}`);
    }
  });

  test('an unreadable file reads n/a', async () => {
    const { exec } = localExec(new Map());
    const input = await newReader(exec).read({ path: PATH, mtimeMs: 1, size: 1 });
    const stats = readStats('omp', input, NOW);

    expect(stats.autocompactions).toBe(NA);
    expect(stats.model).toBe(NA);
  });

  test('Unchanged session is not read again', async () => {
    const text = `${bigSession()}${message('assistant', 53, { usage: { totalTokens: 1234, cost: { total: 0.5 } } })}\n`;
    expect(Buffer.byteLength(text)).toBeGreaterThan(TAIL_BYTES);
    const { exec, calls } = localExec(new Map([[PATH, text]]));
    const reader = newReader(exec);
    const before = readStats('omp', await reader.read(file(text)), NOW);
    expect(before).toMatchObject({ model: 'tail-model', costUsd: 0.5, totalTokens: 1234 });

    // 10 minutes later, the listing gives the same size and modified time
    const mark = calls.length;
    const after = readStats('omp', await reader.read(file(text)), NOW + 10 * 60_000);

    expect(calls.slice(mark).map((call) => call.command)).toEqual([]);
    expect(after).toMatchObject({ model: 'tail-model', costUsd: 0.5, totalTokens: 1234 });
    expect(after.sinceActivityMs).toBe(before.sinceActivityMs + 10 * 60_000);
  });

  test('Read that failed is tried again', async () => {
    const text = bigSession();
    const isTail = (call) => call.command === 'tail' && call.args[1] === String(TAIL_BYTES);
    const faults = { fail: isTail };
    const { exec, calls } = localExec(new Map([[PATH, text]]), faults);
    const reader = newReader(exec);
    expect(readStats('omp', await reader.read(file(text)), NOW).model).toBe(NA);

    // the next listing gives the same size and modified time, and tail works
    faults.fail = null;
    const mark = calls.length;
    const stats = readStats('omp', await reader.read(file(text)), NOW);

    expect(calls.slice(mark).filter(isTail)).toHaveLength(1);
    expect(stats.model).toBe('tail-model');
    expect(stats.sinceActivityMs).toBe(8 * 60_000);
  });

  test('kept scans read back as they were', () => {
    const state = {
      costUsd: { sum: NaN, last: undefined, byModel: { opus: { turns: [1, NaN, undefined], cost: 0.5 } } },
      responses: new Map([
        ['r1', { tokens: 100, cost: undefined }],
        ['r2', { tokens: NaN, parts: new Map([[1, null]]) }],
      ]),
      // fields named as the words the stored value is written in
      $: 'Map',
      entries: 3,
      marks: { $: 'undefined' },
    };
    // when each file was last asked for, and whether it is an ended sub-agent's, read back too,
    // so that a later run drops by them (given in the order they are stored: ended ones first)
    const scans = [
      { provider: 'omp', machine: 'devbox', path: `${PATH}.2`, pos: 0, readAt: NOW, ended: true, state: undefined },
      { provider: 'claude-code', machine: null, path: PATH, pos: 12, readAt: NOW - 1, ended: false, state },
    ];

    // a stored value is JSON
    const stored = JSON.parse(JSON.stringify(encodeScans(scans)));

    expect(decodeScans(stored)).toEqual(scans);
  });

  test('kept scans over Orca\'s cap are split into values under it', () => {
    // 40 scans of about 20 KB each: some 800 KB in all, more than one value of 262144 bytes
    const scans = Array.from({ length: 40 }, (_, i) => ({ provider: 'omp', machine: null, path: `${PATH}.${i}`, pos: i, readAt: i, ended: false, state: { note: 'x'.repeat(20_000) } }));

    const parts = JSON.parse(JSON.stringify(encodeScans(scans)));

    expect(parts.length > 1).toBe(true);
    // each part is one JSON text, so that Orca's pretty-printing of its file leaves it as it is
    for (const part of parts) expect(typeof part).toBe('string');
    for (const part of parts) expect(Buffer.byteLength(JSON.stringify(part)) <= KEPT_VALUE_BYTES).toBe(true);
    expect(keptPartsOf(parts[0])).toBe(parts.length);
    expect(decodeScans(parts)).toEqual(scans);
    // a value missing makes none of them read back
    expect(decodeScans(parts.slice(0, -1))).toEqual([]);
  });

  test('kept scans over the budget drop ended sub-agents first, then the oldest read', () => {
    // 15 ended sub-agent transcripts and 50 session files of about 100 KB each, some 6.5 MB in
    // all: 41 of them fit in KEPT_TOTAL_BYTES, 42 do not
    const scanOf = (path, readAt, ended) => ({ provider: 'omp', machine: null, path, pos: 1, state: { note: 'x'.repeat(100_000) }, readAt, ended });
    const ended = Array.from({ length: 15 }, (_, i) => scanOf(`${PATH}/Impl${i}.jsonl`, 100 + i, true));
    // the session files given newest read first, so that the order read decides, not the order given
    const sessions = Array.from({ length: 50 }, (_, i) => scanOf(`${PATH}.${i}`, i, false)).reverse();

    const parts = JSON.parse(JSON.stringify(encodeScans([...ended, ...sessions])));

    expect(parts.reduce((sum, part) => sum + Buffer.byteLength(JSON.stringify(part)), 0) <= KEPT_TOTAL_BYTES).toBe(true);
    // every ended sub-agent and the 9 session files read first are dropped; the rest read back
    // whole, without how they were ordered
    const kept = decodeScans(parts);
    expect(kept.map(({ path }) => path).sort()).toEqual(sessions.filter(({ readAt }) => readAt >= 9).map(({ path }) => path).sort());
    expect(kept[0]).toEqual({ provider: 'omp', machine: null, path: kept[0].path, pos: 1, readAt: kept[0].readAt, ended: false, state: { note: 'x'.repeat(100_000) } });
  });
});
