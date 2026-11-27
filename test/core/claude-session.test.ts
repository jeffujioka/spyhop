import { describe, test } from 'node:test';
import { NA, readStats } from '../../src/core/providers/index.js';
import { fixtureText } from '../helpers/files.ts';
import { CLAUDE_BASIC as BASIC, claudeAssistant as assistant, claudeBoundary, claudeUsage as usage } from './helpers/entries.ts';
import { expect } from './helpers/expect.ts';

const LAST_REPLY = Date.parse('2026-09-07T20:21:34.167Z'); // last assistant line of basic.jsonl
const boundary = (trigger) => claudeBoundary('2026-09-07T20:19:00.000Z', trigger);

describe('claude session: model, tokens, cache and duration', () => {
  test('claude session details', () => {
    const stats = readStats('claude-code', BASIC, LAST_REPLY + 60_000);

    expect(stats.harness).toBe('claude-code');
    expect(stats.model).toBe('claude-opus-4-6');
    // first message 20:17:49.637Z, last message 20:21:34.167Z
    expect(stats.durationMs).toBe(224530);
    // One API response is written as one line per content block with the same message id and
    // usage; each response counts once: input + output + cache read + cache creation.
    expect(stats.totalTokens).toBe(33561 + 34512 + 36580 + 37580 + 38329);
    expect(stats.cacheHitRate).toBeCloseTo(139797 / (11 + 139797 + 37716), 12);
    expect(stats.cacheHits).toBe(4);
    expect(stats.cacheMisses).toBe(1);
    // the latest response's prompt: input + cache read + cache creation
    expect(stats.contextTokens).toBe(3 + 36876 + 840);
    // the last response wrote a 5-minute cache entry a minute ago
    expect(stats.cacheLeftMs).toBe(4 * 60_000);
    expect(stats.sinceActivityMs).toBe(60_000);
    // last turn: last assistant line minus the prompt that began it (tool results do not)
    expect(stats.latencyMs).toBe(13994);
    expect(stats.burnTokensPerMin).toBeCloseTo(180562 / (224530 / 60000), 9);
  });

  test('claude missing field is n/a', () => {
    const stats = readStats('claude-code', fixtureText('claude/no-usage.jsonl'), Date.now());

    for (const field of ['totalTokens', 'contextTokens', 'cacheHitRate', 'cacheHits', 'cacheMisses', 'cacheLeftMs', 'costUsd', 'burnTokensPerMin']) {
      expect(stats[field]).toBe(NA);
    }
    // the other figures still show
    expect(stats.model).toBe('claude-opus-4-6');
    expect(stats.durationMs).toBe(13915); // 20:17:49.637Z to 20:18:03.552Z

    // figures the session files never hold read n/a, whatever the session
    const full = readStats('claude-code', BASIC, LAST_REPLY);
    for (const field of ['contextMax', 'contextPercent', 'headroomTokens', 'burnCostPerHour', 'thinkingLevel', 'premiumRequests']) {
      expect(full[field]).toBe(NA);
    }
  });

  test('a placeholder reply the API never made is not a turn', () => {
    const text = `${BASIC}${assistant('2026-09-07T20:22:00.000Z', 'syn', usage(0, 0, 0, 0), '<synthetic>')}\n`;
    const stats = readStats('claude-code', text, LAST_REPLY);

    expect(stats.model).toBe('claude-opus-4-6');
    expect(stats.cacheMisses).toBe(1);
    expect(stats.contextTokens).toBe(3 + 36876 + 840);
  });

  test('cost is the one Claude logged, and only while no later turn has been added', () => {
    expect(readStats('claude-code', BASIC, LAST_REPLY).costUsd).toBe(1.25);
    // a turn after the logged total: it is stale, so it is not shown
    const later = `${BASIC}${assistant('2026-09-07T20:30:00.000Z', 'msg_06', usage(1, 1, 1, 1))}\n`;
    expect(readStats('claude-code', later, LAST_REPLY).costUsd).toBe(NA);
    // a cost that is not a number is no figure
    const bad = BASIC.replace('"totalCostUSD":1.25', '"totalCostUSD":"1.25"');
    expect(readStats('claude-code', bad, LAST_REPLY).costUsd).toBe(NA);
  });

  test('cache lifetime follows the class of the last turn', () => {
    const turn = (creation) => `${assistant('2026-09-07T20:00:00.000Z', 'm', usage(1, 1, 0, 10, creation))}\n`;
    const at = Date.parse('2026-09-07T20:10:00.000Z');
    expect(readStats('claude-code', turn({ ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 }), at).cacheLeftMs).toBe(50 * 60_000);
    expect(readStats('claude-code', turn({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 10 }), at).cacheLeftMs).toBe(0);
    // no breakdown, or none written this turn: the class is not known
    expect(readStats('claude-code', turn(undefined), at).cacheLeftMs).toBe(NA);
    expect(readStats('claude-code', turn({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }), at).cacheLeftMs).toBe(NA);
  });

  test('autocompactions are the automatic compact boundaries of a whole file', () => {
    const text = `${boundary('manual')}\n${boundary('auto')}\n${BASIC}${boundary('auto')}\n`;

    expect(readStats('claude-code', { text, sources: { wholeFile: true } }, LAST_REPLY).autocompactions).toBe(2);
    expect(readStats('claude-code', { text: BASIC, sources: { wholeFile: true } }, LAST_REPLY).autocompactions).toBe(0);
    // a tail window can hold only some of them: unknown, never 0
    expect(readStats('claude-code', { text, sources: { wholeFile: false } }, LAST_REPLY).autocompactions).toBe(NA);
    expect(readStats('claude-code', text, LAST_REPLY).autocompactions).toBe(NA);
  });

  test('a compact boundary with another trigger makes the count unknown', () => {
    const whole = { wholeFile: true };
    // a trigger Claude Code may use for its own compactions under a name this reader does not know
    for (const trigger of ['scheduled', undefined]) {
      const text = `${boundary('auto')}\n${boundary(trigger)}\n${BASIC}`;
      expect(readStats('claude-code', { text, sources: whole }, LAST_REPLY).autocompactions).toBe(NA);
    }
    // manual and auto are known kinds
    expect(readStats('claude-code', { text: `${boundary('manual')}\n${boundary('auto')}\n${BASIC}`, sources: whole }, LAST_REPLY).autocompactions).toBe(1);
  });

  test('the latency of the last turn skips a placeholder reply', () => {
    const prompt = JSON.stringify({ type: 'user', timestamp: '2026-09-07T20:00:00.000Z', message: { role: 'user', content: 'hi' } });
    const reply = assistant('2026-09-07T20:00:10.000Z', 'r1', usage(1, 1, 0, 0));
    const placeholder = assistant('2026-09-07T20:00:40.000Z', 'syn', usage(0, 0, 0, 0), '<synthetic>');

    expect(readStats('claude-code', `${prompt}\n${reply}\n${placeholder}\n`, LAST_REPLY).latencyMs).toBe(10_000);
    // nothing but a placeholder answered: there is no turn to time
    expect(readStats('claude-code', `${prompt}\n${placeholder}\n`, LAST_REPLY).latencyMs).toBe(NA);
  });
});

describe('claude session: the series of the whole session', () => {
  const whole = (lines: string[]) => readStats('claude-code', { text: lines.join('\n'), sources: { wholeFile: true } }, LAST_REPLY);

  test('a response of several blocks is one point', () => {
    const stats = whole([
      JSON.stringify({ type: 'user', timestamp: '2026-11-02T11:00:00.000Z', message: { role: 'user', content: 'hi' } }),
      assistant('2026-11-02T11:00:10.000Z', 'r1', usage(10, 5, 100, 20)),
      // the three content blocks of the response r2; the last one logs the response's final output
      assistant('2026-11-02T11:01:01.000Z', 'r2', usage(30, 7, 400, 50)),
      assistant('2026-11-02T11:01:02.000Z', 'r2', usage(30, 7, 400, 50)),
      assistant('2026-11-02T11:01:03.000Z', 'r2', usage(30, 9, 400, 50)),
    ]);

    expect(stats.detail.points).toEqual([
      { t: Date.parse('2026-11-02T11:00:10.000Z'), n: 1, read: 100, write: 20, uncached: 10, output: 5, cost: null, context: 130 },
      { t: Date.parse('2026-11-02T11:01:03.000Z'), n: 1, read: 400, write: 50, uncached: 30, output: 9, cost: null, context: 480 },
    ]);
    // the points hold the tokens the totals count
    expect(stats.totalTokens).toBe(135 + 489);
    expect(stats.calls).toBe(2);
    expect(stats.firstMessageMs).toBe(Date.parse('2026-11-02T11:00:00.000Z'));
  });

  test('compact boundaries keep their tokens before and after', () => {
    const compacted = (timestamp: string, metadata: object) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp, compactMetadata: metadata });

    const stats = whole([
      compacted('2026-11-02T11:00:00.000Z', { trigger: 'manual', preTokens: 181_586, postTokens: 27_805 }),
      compacted('2026-11-02T11:30:00.000Z', { trigger: 'auto', preTokens: 170_000 }),
    ]);

    expect(stats.detail.marks).toEqual([
      { t: Date.parse('2026-11-02T11:00:00.000Z'), before: 181_586, after: 27_805 },
      // a boundary that logged no tokens after reads n/a for them
      { t: Date.parse('2026-11-02T11:30:00.000Z'), before: 170_000, after: null },
    ]);
  });

  test('tool uses by tool, failures from is_error', () => {
    const uses = (timestamp: string, id: string, tools: string[]) =>
      assistant(timestamp, id, usage(1, 1, 1, 1), 'claude-opus-4-6', tools.map((tool) => ({ type: 'tool_use', id: tool, name: 'Bash', input: {} })));
    const results = (timestamp: string, answers: [string, boolean | null][]) =>
      JSON.stringify({
        type: 'user',
        timestamp,
        message: { role: 'user', content: answers.map(([id, failed]) => ({ type: 'tool_result', tool_use_id: id, is_error: failed, content: '' })) },
      });

    const stats = whole([
      uses('2026-11-02T11:00:00.000Z', 'r1', ['t1', 't2']),
      results('2026-11-02T11:00:05.000Z', [['t1', null], ['t2', true]]),
      uses('2026-11-02T11:00:10.000Z', 'r2', ['t3']),
      results('2026-11-02T11:00:15.000Z', [['t3', false]]),
    ]);

    expect(stats.detail.tools).toEqual({ Bash: { calls: 3, failed: 1 } });
  });

  test('tokens by model, no cost', () => {
    const stats = whole([
      assistant('2026-11-02T11:00:00.000Z', 'r1', usage(10, 5, 0, 1000), 'claude-opus-4-6'),
      assistant('2026-11-02T11:01:00.000Z', 'r2', usage(10, 5, 1000, 0), 'claude-opus-4-6'),
      assistant('2026-11-02T11:02:00.000Z', 'r3', usage(10, 5, 0, 200_000), 'haiku'),
      assistant('2026-11-02T11:03:00.000Z', 'r4', usage(10, 5, 200_000, 0), 'haiku'),
      assistant('2026-11-02T11:04:00.000Z', 'r5', usage(10, 5, 0, 300_000), 'haiku'),
    ]);

    expect(stats.detail.models).toEqual({ 'claude-opus-4-6': { cost: null, tokens: 2030 }, haiku: { cost: null, tokens: 700_045 } });
    // the cold starts are counted, but Claude Code logs no cost of their writes
    expect(stats.detail.cold).toEqual({ count: 2, tokens: 500_000, cost: null });
  });
});
