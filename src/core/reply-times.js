// The Health tab's reply times and failure types: the types the failed model calls are told apart
// by, and the histogram a model's reply times are kept in, as geometric buckets a store can sum:
// a bucket spans REPLY_RATIO times its lower edge, so the middle of a bucket is within 10% of any
// reply time in it.

// The types of a failed model call.
export const FAILURE_TYPES = ['network', 'auth', 'notFound', 'rateLimit', 'server', 'other'];

const NETWORK_TEXT = /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|Couldn't reach|fetch failed/;
const STATUS_TEXT = /\b([45]\d\d)\b/;
// opencode's error types that name a type of their own, whatever status they log
const BY_TYPE = { 'provider.transport': 'network', 'provider.auth': 'auth' };

// The type of the failure with the HTTP `status`, the error `text` or opencode's error `type`: a
// network failure by its type or its text, else by the status, the first HTTP status of the text
// when none is given; any other is `other`.
export function failureType({ status, text, type } = {}) {
  if (BY_TYPE[type]) return BY_TYPE[type];
  if (typeof text === 'string' && NETWORK_TEXT.test(text)) return 'network';
  const code = Number.isInteger(status) ? status : Number(STATUS_TEXT.exec(typeof text === 'string' ? text : '')?.[1]);
  if (code === 401 || code === 403) return 'auth';
  if (code === 404) return 'notFound';
  if (code === 429) return 'rateLimit';
  if (code >= 500 && code <= 599) return 'server';
  return 'other';
}

// How much a bucket's upper edge is above its lower.
export const REPLY_RATIO = 1.2;
const LOG_RATIO = Math.log(REPLY_RATIO);

// The bucket of a reply time of `ms` (above 0): its index in the geometric scale from 1 ms.
export const replyBucket = (ms) => Math.floor(Math.log(ms) / LOG_RATIO);

// The reply time, ms, at the quantile `q` (0-1) of `counts`, bucket -> how many replies: the
// nearest rank's bucket, by its geometric middle; null without a reply.
export function replyQuantile(counts, q) {
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  if (total <= 0) return null;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (const bucket of [...counts.keys()].sort((a, b) => a - b)) {
    seen += counts.get(bucket);
    if (seen >= rank) return REPLY_RATIO ** (bucket + 0.5);
  }
  return null;
}
