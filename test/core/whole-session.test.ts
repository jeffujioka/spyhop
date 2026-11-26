import { describe, test } from 'node:test';
import { NA, readStats } from '../../src/core/providers/index.js';
import { parseEntries } from '../../src/core/providers/jsonl.js';
import { claudeProvider } from '../../src/core/providers/claude.js';
import { ompProvider } from '../../src/core/providers/omp.js';
import { createClaudeSessions } from '../../src/core/providers/claude-sources.js';
import { createOmpSessions } from '../../src/core/providers/omp-sources.js';
import { SCAN_CHUNK_BYTES, TAIL_BYTES } from '../../src/core/refresh.js';
import { claudeAssistant, claudeBoundary, claudeUsage, sessionFile } from './helpers/entries.ts';
import { expect } from './helpers/expect.ts';
import { EXEC_CAP, localExec } from './helpers/local-exec.ts';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const T0 = NOW - 24 * 60 * 60_000;
const OMP_PATH = '/home/u/.omp/agent/sessions/--proj--/big.jsonl';
const CLAUDE_PATH = '/home/u/.claude/projects/-proj/big.jsonl';

const stamp = (minute) => new Date(T0 + minute * 60_000).toISOString();
const filler = 'x'.repeat(2000);

// ---- omp ---------------------------------------------------------------------------------

const ompUser = (minute) => JSON.stringify({ type: 'message', id: `u${minute}`, timestamp: stamp(minute), message: { role: 'user', content: filler } });
const ompTurn = (minute, [input, output, cacheRead, cacheWrite, cost], model = 'early-model') =>
  JSON.stringify({
    type: 'message',
    id: `a${minute}`,
    timestamp: stamp(minute),
    message: {
      role: 'assistant',
      provider: 'p',
      model,
      content: filler,
      usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { total: cost }, premiumRequests: 1 },
    },
  });

// Turns of an omp session: the first two (a miss, then a hit) are far out of the tail window's
// reach, the last two (a hit, a miss) inside it.
const EARLY = [[10, 20, 0, 100, 0.5], [5, 6, 100, 0, 0.25]];
const LATE = [[1, 2, 300, 0, 0.125], [3, 4, 0, 50, 0.0625]];

// `pad` lengthens the filler so a file can reach any size; `gap` is the lines between the early
// and the late turns. The minute of a message is its number, so the session lasts one minute
// less than it has messages.
function ompSession({ bytes = TAIL_BYTES * 4, extra = [] } = {}) {
  const lines = [JSON.stringify({ type: 'session', id: 's', timestamp: stamp(0) }), JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'high' }), JSON.stringify({ type: 'compaction', id: 'c1' })];
  let minute = 0;
  for (const turn of EARLY) lines.push(ompTurn(minute++, turn));
  while (lines.join('\n').length < bytes) lines.push(ompUser(minute++));
  lines.push(JSON.stringify({ type: 'compaction', id: 'c2' }));
  lines.push(ompTurn(minute++, LATE[0], 'tail-model'), ompTurn(minute++, LATE[1], 'tail-model'));
  lines.push(...extra.map((turn) => ompTurn(minute++, turn, 'tail-model')));
  return { text: `${lines.join('\n')}\n`, messages: minute };
}

const ompFile = (text, path = OMP_PATH) => sessionFile(text, path);

function ompReader(exec) {
  const sessions = createOmpSessions({ execOn: () => exec, readTextOn: () => async () => null });
  return async (file) => readStats('omp', await sessions.read(file, { machine: null, home: '/home/u', now: NOW }), NOW);
}

// ---- Claude Code ---------------------------------------------------------------------------

const claudeUser = (minute) => JSON.stringify({ type: 'user', timestamp: stamp(minute), message: { role: 'user', content: filler } });
const claudeBlock = (minute, id, [input, output, cacheRead, cacheWrite], model = 'early-model') =>
  claudeAssistant(stamp(minute), id, claudeUsage(input, output, cacheRead, cacheWrite), model);
const boundary = (trigger) => claudeBoundary(stamp(0), trigger);

// Two responses early, two in the tail; the early one with two blocks (one entry per content block).
function claudeSession({ bytes = TAIL_BYTES * 4 } = {}) {
  const lines = [boundary('auto'), claudeBlock(0, 'r1', [10, 20, 0, 100]), claudeBlock(1, 'r1', [10, 20, 0, 100]), claudeBlock(2, 'r2', [5, 6, 100, 0])];
  let minute = 3;
  while (lines.join('\n').length < bytes) lines.push(claudeUser(minute++));
  lines.push(boundary('auto'), claudeBlock(minute++, 'r3', [1, 2, 300, 0], 'tail-model'), claudeBlock(minute++, 'r4', [3, 4, 0, 50], 'tail-model'));
  return { text: `${lines.join('\n')}\n`, messages: minute };
}

const claudeFile = (text) => sessionFile(text, CLAUDE_PATH);

function claudeReader(exec) {
  const sessions = createClaudeSessions({ execOn: () => exec });
  return async (file) => readStats('claude-code', await sessions.read(file, { machine: null }), NOW);
}

// ---- the scenarios -------------------------------------------------------------------------

describe('whole-session figures on a large file', () => {
  test('totals cover the whole file', async () => {
    const { text, messages } = ompSession();
    expect(Buffer.byteLength(text)).toBeGreaterThan(TAIL_BYTES * 3);
    const { exec } = localExec(new Map([[OMP_PATH, text]]));
    const stats = await ompReader(exec)(ompFile(text));

    // all four turns, though the first two lie outside the 256 KiB tail
    expect(stats.totalTokens).toBe(130 + 111 + 303 + 57);
    expect(stats.costUsd).toBeCloseTo(0.5 + 0.25 + 0.125 + 0.0625, 12);
    expect(stats.premiumRequests).toBe(4);
    expect(stats.cacheHitRate).toBeCloseTo(400 / (19 + 400 + 150), 12);
    expect(stats.cacheHits).toBe(2);
    expect(stats.cacheMisses).toBe(2);
    expect(stats.durationMs).toBe((messages - 1) * 60_000);
    expect(stats.thinkingLevel).toBe('high'); // set at the top of the file
    expect(stats.autocompactions).toBe(2);
    expect(stats.burnTokensPerMin).toBeCloseTo(601 / (stats.durationMs / 60000), 9);
    expect(stats.burnCostPerHour).toBeCloseTo(0.9375 / (stats.durationMs / 3600000), 9);
    // the figures about the end of the file still come from the tail
    expect(stats.model).toBe('tail-model');
    expect(stats.sinceActivityMs).toBe(NOW - (T0 + (messages - 1) * 60_000));

    // Claude Code: the same
    const claude = claudeSession();
    expect(Buffer.byteLength(claude.text)).toBeGreaterThan(TAIL_BYTES * 3);
    const claudeStats = await claudeReader(localExec(new Map([[CLAUDE_PATH, claude.text]])).exec)(claudeFile(claude.text));
    expect(claudeStats.totalTokens).toBe(130 + 111 + 303 + 57); // the two blocks of r1 count once
    expect(claudeStats.cacheHitRate).toBeCloseTo(400 / (19 + 400 + 150), 12);
    expect(claudeStats.cacheHits).toBe(2);
    expect(claudeStats.cacheMisses).toBe(2);
    expect(claudeStats.durationMs).toBe((claude.messages - 1) * 60_000);
    expect(claudeStats.autocompactions).toBe(2);
    expect(claudeStats.model).toBe('tail-model');
    expect(claudeStats.burnTokensPerMin).toBeCloseTo(601 / (claudeStats.durationMs / 60000), 9);
  });

  test('later refresh reads only appended bytes', async () => {
    const { text } = ompSession();
    const files = new Map([[OMP_PATH, text]]);
    const { exec, calls, served } = localExec(files);
    const read = ompReader(exec);
    await read(ompFile(text));

    // unchanged: nothing is read
    let mark = calls.length;
    expect((await read(ompFile(text))).totalTokens).toBe(601);
    expect(calls.slice(mark).map((call) => call.command)).toEqual([]);

    // the session grows: the tail, the appended lines, and a byte to check where they begin
    const appended = `${ompTurn(9000, [7, 8, 9, 10, 1], 'tail-model')}\n${JSON.stringify({ type: 'compaction', id: 'c3' })}\n`;
    const grown = text + appended;
    files.set(OMP_PATH, grown);
    mark = calls.length;
    const stats = await read(ompFile(grown));

    expect(stats.totalTokens).toBe(601 + 34);
    expect(stats.costUsd).toBeCloseTo(0.9375 + 1, 12);
    expect(stats.cacheHits).toBe(3);
    expect(stats.autocompactions).toBe(3);
    expect(calls.slice(mark).map((call) => call.command)).toEqual(['tail', 'tail']);
    expect(served(mark)).toBeLessThanOrEqual(TAIL_BYTES + Buffer.byteLength(appended) + 1);
    expect(calls.some((call, i) => i >= mark && call.command === 'dd')).toBe(false);
  });

  test('scan reads in bounded chunks', async () => {
    // a file over the runner's whole output cap: no single read can take it. An assistant turn
    // with usage lies across the end of the first block and a compaction across the end of the
    // second, so a carried line that was lost or folded twice would change the figures.
    const turn = ompTurn(2, [100, 200, 300, 400, 2]);
    const compact = JSON.stringify({ type: 'compaction', id: 'c-straddle', summary: 's'.repeat(500) });
    const lines = [JSON.stringify({ type: 'session', id: 's', timestamp: stamp(0) }), JSON.stringify({ type: 'compaction', id: 'c1' }), ompTurn(0, EARLY[0]), ompTurn(1, EARLY[1])];
    const place = (target, boundary) => {
      const here = Buffer.byteLength(lines.join('\n')) + 1;
      const note = (n) => JSON.stringify({ type: 'custom', note: 'n'.repeat(n) });
      const start = boundary - Math.floor(Buffer.byteLength(target) / 2);
      lines.push(note(start - here - Buffer.byteLength(note(0)) - 1), target);
    };
    place(turn, SCAN_CHUNK_BYTES);
    place(compact, 2 * SCAN_CHUNK_BYTES);
    lines.push(ompTurn(3, LATE[0], 'tail-model'), ompTurn(4, LATE[1], 'tail-model'));
    const text = `${lines.join('\n')}\n`;
    const bytes = Buffer.from(text);
    expect(bytes.length).toBeGreaterThan(EXEC_CAP);
    // both lines do run across a block boundary
    for (const [target, boundary] of [[turn, SCAN_CHUNK_BYTES], [compact, 2 * SCAN_CHUNK_BYTES]]) {
      const start = bytes.indexOf(target);
      expect(start).toBeLessThan(boundary);
      expect(start + Buffer.byteLength(target)).toBeGreaterThan(boundary);
    }

    const files = new Map([[OMP_PATH, bytes]]);
    const { exec, calls } = localExec(files);
    const stats = await ompReader(exec)(ompFile(text));

    const scan = calls.filter((call) => call.command === 'dd');
    expect(scan.length).toBeGreaterThanOrEqual(3);
    for (const call of scan) {
      expect(call.served).toBeLessThanOrEqual(SCAN_CHUNK_BYTES);
      expect(call.served).toBeLessThanOrEqual(EXEC_CAP);
    }
    expect(SCAN_CHUNK_BYTES).toBeLessThanOrEqual(EXEC_CAP);
    // each block follows the one before; none is read twice
    expect(scan.map((call) => call.args[2])).toEqual(scan.map((_, k) => `skip=${k}`));
    // each carried line is folded once, whole: the turn that crosses a boundary is in the
    // totals once, and so is the compaction
    expect(stats.totalTokens).toBe(130 + 111 + 1000 + 303 + 57);
    expect(stats.costUsd).toBeCloseTo(0.5 + 0.25 + 2 + 0.125 + 0.0625, 12);
    expect(stats.premiumRequests).toBe(5);
    expect(stats.cacheHitRate).toBeCloseTo(700 / (119 + 700 + 550), 12);
    expect(stats.cacheHits).toBe(3);
    expect(stats.cacheMisses).toBe(2);
    expect(stats.autocompactions).toBe(2);
  });

  test('a character cut by a block boundary does not move where the next read starts', async () => {
    // a 4-byte character placed so that the first block ends two bytes into it
    const session = ompSession({ bytes: 300_000 });
    const lines = session.text.split('\n');
    const head = '{"type":"custom","note":"';
    const prefix = Buffer.byteLength(lines.slice(0, 3).join('\n')) + 1;
    lines.splice(3, 0, `${head}${'n'.repeat(SCAN_CHUNK_BYTES - 2 - prefix - head.length)}😀"}`);
    const text = lines.join('\n');
    expect(Buffer.from(text)[SCAN_CHUNK_BYTES] & 0xc0).toBe(0x80);

    const files = new Map([[OMP_PATH, text]]);
    const { exec, calls } = localExec(files);
    const read = ompReader(exec);
    expect((await read(ompFile(text))).totalTokens).toBe(601);

    // the next refresh starts exactly after the last whole line: no recount, no rescan
    const grown = `${text}${ompTurn(9000, [7, 8, 9, 10, 1], 'tail-model')}\n`;
    files.set(OMP_PATH, grown);
    const mark = calls.length;
    expect((await read(ompFile(grown))).totalTokens).toBe(601 + 34);
    expect(calls.slice(mark).some((call) => call.command === 'dd')).toBe(false);
  });

  test('replaced file is scanned again', async () => {
    const first = ompSession();
    const files = new Map([[OMP_PATH, first.text]]);
    const { exec, calls } = localExec(files);
    const read = ompReader(exec);
    expect((await read(ompFile(first.text))).totalTokens).toBe(601);

    // a smaller file, still over the tail window, with one turn of its own
    const replaced = `${[JSON.stringify({ type: 'session', id: 'other', timestamp: stamp(0) }), ompTurn(0, [1, 1, 1, 1, 9], 'new-model'), ...Array.from({ length: 150 }, (_, i) => ompUser(i + 1))].join('\n')}\n`;
    expect(Buffer.byteLength(replaced)).toBeGreaterThan(TAIL_BYTES);
    expect(Buffer.byteLength(replaced)).toBeLessThan(Buffer.byteLength(first.text));
    files.set(OMP_PATH, replaced);
    const mark = calls.length;
    const stats = await read(ompFile(replaced));

    // nothing of the old file is left in the figures
    expect(stats.totalTokens).toBe(4);
    expect(stats.costUsd).toBe(9);
    expect(stats.cacheHits).toBe(1);
    expect(stats.cacheMisses).toBe(0);
    expect(stats.autocompactions).toBe(0);
    expect(stats.thinkingLevel).toBe(NA);
    expect(calls[mark + 1].command).toBe('dd');
    expect(calls[mark + 1].args).toContain('skip=0');
  });

  test('a figure is the same read at once or in pieces', async () => {
    const { text } = ompSession();
    const { text: claudeText } = claudeSession();
    for (const [harness, whole] of [['omp', text], ['claude-code', claudeText]]) {
      const { fold } = harness === 'omp' ? ompProvider : claudeProvider;
      const lines = whole.split('\n');
      const atOnce = fold(undefined, parseEntries(whole));
      // pieces cut anywhere between lines, one of them inside a Claude response's blocks
      let state;
      for (let from = 0; from < lines.length; from += 97) state = fold(state, parseEntries(lines.slice(from, from + 97).join('\n')));
      const odd = fold(fold(undefined, parseEntries(lines.slice(0, 2).join('\n'))), parseEntries(lines.slice(2).join('\n')));
      const stats = (state) => readStats(harness, { text: lines.slice(-3).join('\n'), state }, NOW);
      expect(stats(state)).toEqual(stats(atOnce));
      expect(stats(odd)).toEqual(stats(atOnce));
    }
  });

  test('latency and thinking survive a large file', async () => {
    // the last turn's user message and the thinking-level entry lie far before the tail window:
    // entries that are no message fill the space between them and the last reply
    const pad = Array.from({ length: Math.ceil((TAIL_BYTES * 2) / 2000) }, () => JSON.stringify({ type: 'custom', note: filler }));
    const outside = (text, needle) => expect(text.slice(-TAIL_BYTES)).not.toContain(needle);

    const omp = `${[
      JSON.stringify({ type: 'session', id: 's', timestamp: stamp(0) }),
      JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'high' }),
      ompUser(0),
      ompTurn(1, EARLY[0]),
      ompUser(2),
      ...pad,
      ompTurn(5, LATE[0], 'tail-model'),
    ].join('\n')}\n`;
    expect(Buffer.byteLength(omp)).toBeGreaterThan(TAIL_BYTES * 2);
    outside(omp, '"id":"u2"');
    outside(omp, 'thinking_level_change');
    const stats = await ompReader(localExec(new Map([[OMP_PATH, omp]])).exec)(ompFile(omp));
    // the reply at minute 5 minus the user message of minute 2
    expect(stats.latencyMs).toBe(3 * 60_000);
    expect(stats.thinkingLevel).toBe('high');
    expect(stats.model).toBe('tail-model');

    // Claude Code: the same latency (it logs no thinking level)
    const claude = `${[claudeUser(0), claudeBlock(1, 'r1', [10, 20, 0, 100]), claudeUser(2), ...pad, claudeBlock(5, 'r2', [1, 2, 300, 0], 'tail-model')].join('\n')}\n`;
    expect(Buffer.byteLength(claude)).toBeGreaterThan(TAIL_BYTES * 2);
    outside(claude, '"type":"user"');
    const claudeStats = await claudeReader(localExec(new Map([[CLAUDE_PATH, claude]])).exec)(claudeFile(claude));
    expect(claudeStats.latencyMs).toBe(3 * 60_000);
    expect(claudeStats.model).toBe('tail-model');
  });
});
