/**
 * Rejects if `promise` has not settled within `ms`.
 *
 * Written because `kafkajs` does not reject when a broker is unreachable: it
 * retries the seed broker indefinitely, so `connect()` and `send()` simply
 * never settle. An `await` on either is therefore an unbounded await, and one
 * of those inside a loop is enough to stall a background worker permanently.
 *
 * The underlying operation is not cancellable and keeps running. Callers must
 * be safe against it succeeding later -- for the event pipeline that means a
 * duplicate message, which the status-based claim already makes harmless.
 */
export function withDeadline(promise, ms, message) {
  let timer;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
