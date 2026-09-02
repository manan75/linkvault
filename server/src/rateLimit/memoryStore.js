/**
 * A fixed-window counter held in process memory.
 *
 * Sufficient while there is exactly one API process, which is what the free
 * Render tier gives. It is honestly not a distributed rate limiter and does not
 * pretend to be: counters reset when the process restarts, and Render restarts
 * it on every deploy and after every idle spin-down.
 *
 * That loss is acceptable here **only because of what is stored in it**. These
 * counters are throttles -- brute-force and flood protection -- and a throttle
 * that resets occasionally is still a throttle. The two limits that bound real
 * money (the per-user link cap and the daily enrichment ceiling) deliberately
 * live in MongoDB instead, in `services/usage.js`, precisely because losing
 * those on restart would make them meaningless.
 */
export function createMemoryRateLimitStore({ sweepIntervalMs = 60_000 } = {}) {
  /** key -> { count, resetAt } */
  const windows = new Map();
  let timer = null;

  /**
   * Drops expired windows.
   *
   * Not housekeeping. Auth endpoints are keyed by IP and reachable by anyone, so
   * without this the map grows by one entry per unique address and never
   * shrinks -- an unbounded leak on a 512MB instance, reachable by a stranger.
   */
  function sweep(now = Date.now()) {
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
  }

  return {
    /** Counts one request against `key`, returning the state of its window. */
    async hit(key, windowMs, now = Date.now()) {
      const current = windows.get(key);

      if (!current || current.resetAt <= now) {
        const started = { count: 1, resetAt: now + windowMs };
        windows.set(key, started);
        return { ...started };
      }

      current.count += 1;
      return { ...current };
    },

    async reset(key) {
      windows.delete(key);
    },

    /** Drops every window. Used between tests, which share one process. */
    clear() {
      windows.clear();
    },

    start() {
      if (timer) return;
      timer = setInterval(() => sweep(), sweepIntervalMs);
      // Never a reason to hold the process open for a cleanup pass.
      timer.unref?.();
    },

    stop() {
      clearInterval(timer);
      timer = null;
    },

    // Test seams. Nothing in the application reads either.
    sweep,
    get size() {
      return windows.size;
    },
  };
}
