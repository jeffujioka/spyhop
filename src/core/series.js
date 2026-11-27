// Series of a session for the card and the session screen: what the providers' folds keep beside
// their totals, over the whole file. Runtime-neutral and pure, like the providers that use it.

// The card's spark line draws the context after each of the session's last this many model calls.
export const SPARK_CALLS = 30;

// Adds the context after one model call to `recent`, the contexts of the latest calls, oldest
// first, and drops the oldest beyond SPARK_CALLS; it changes `recent` and returns it, so a fold's
// state keeps one bounded list however long the session runs.
export function pushRecent(recent, context) {
  recent.push(context);
  if (recent.length > SPARK_CALLS) recent.splice(0, recent.length - SPARK_CALLS);
  return recent;
}

// The `detail` of `readStats` from the series a provider kept over the whole session. A copy,
// since a fold's state goes on folding what the file appends after this read.
export function detailOf({ recent }) {
  return { recent: [...recent] };
}
