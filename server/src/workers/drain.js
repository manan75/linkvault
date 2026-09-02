/**
 * Tracks in-flight handler runs so a worker can be stopped without severing
 * work that is halfway through.
 *
 * The failure this prevents is specific and routine rather than theoretical.
 * Render sends SIGTERM on **every** deploy. Without this, a link being fetched
 * or summarised at that moment is abandoned mid-claim: it stays `processing`,
 * holding a lease nothing will release, and only escapes when the stale-lease
 * sweep notices minutes later. Waiting a few seconds for it to finish turns a
 * routine deploy from something that strands work into something that does not.
 *
 * Refusing new work while draining is the other half. A worker that keeps
 * accepting messages during shutdown never finishes draining, and the timeout
 * backstop in `index.js` would fire on every single deploy.
 */
export function createDrain() {
  const inFlight = new Set();
  let draining = false;

  return {
    get draining() {
      return draining;
    },

    get size() {
      return inFlight.size;
    },

    /** Runs `work`, remembering it until it settles. Rejections still reach the caller. */
    track(work) {
      const running = Promise.resolve().then(work);

      inFlight.add(running);
      // The tracking chain swallows the rejection so it cannot surface as an
      // unhandled rejection here; `running` itself is returned untouched, so
      // the caller's own error handling is unaffected.
      running
        .catch(() => {})
        .finally(() => inFlight.delete(running));

      return running;
    },

    /** Stops accepting work and waits for what is already running. */
    async drain() {
      draining = true;
      await Promise.allSettled([...inFlight]);
    },
  };
}
