// Session lines and files the core tests build: omp and Claude Code entries as their harnesses
// log them, with fake figures, and a session file as the session reader takes it.

// One omp message entry of `role` at the ISO `timestamp`; an assistant's has provider, model and
// stop reason, `extra` (message fields such as model or completedAt) is merged in as given, and
// `usage` is left out when null.
export function ompMessage(role: string, timestamp: string, usage: object | null = null, extra: object = {}) {
  const message: Record<string, unknown> = { role, ...(role === 'assistant' && { provider: 'p', model: 'm', stopReason: 'stop' }), ...extra };
  if (usage) message.usage = usage;
  return JSON.stringify({ type: 'message', id: role, timestamp, message });
}

// Claude Code's usage of one response, as its session file logs it.
export const claudeUsage = (input: number, output: number, cacheRead: number, cacheWrite: number, creation?: object) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  ...(creation && { cache_creation: creation }),
});

// One Claude Code assistant entry of the response `id` at the ISO `timestamp`; `usage` is left
// out when null.
export const claudeAssistant = (timestamp: string, id: string, usage: object | null, model = 'claude-opus-4-6') =>
  JSON.stringify({ type: 'assistant', timestamp, message: { id, role: 'assistant', model, content: [], ...(usage && { usage }) } });

// Claude Code's compaction boundary, with no trigger in its metadata when `trigger` is undefined.
export const claudeBoundary = (timestamp: string, trigger?: string) =>
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp, compactMetadata: trigger === undefined ? {} : { trigger } });

// A session file of `text` at `path`, as the session reader takes it.
export const sessionFile = (text: string, path: string, mtimeMs = 1000) => ({ path, mtimeMs, size: Buffer.byteLength(text) });
