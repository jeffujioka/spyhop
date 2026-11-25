// A cache of values that are asked again only after `ttlMs`: `createTtlCache(ttlMs)` returns
// `cached(key, now, load)`, which gives the value `load()` gave for `key` less than `ttlMs`
// before `now` (epoch milliseconds), else calls `load()` and keeps what it returns. A promise is
// kept as it is, so callers asking at once share one load. spyhop's own, not copied from
// herdr-session-stats.
export function createTtlCache(ttlMs) {
  // key -> { at, value } of its last load
  const entries = new Map();
  return (key, now, load) => {
    const hit = entries.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
    const value = load();
    entries.set(key, { at: now, value });
    return value;
  };
}
