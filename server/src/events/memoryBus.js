/**
 * An event bus that never leaves the process.
 *
 * Two jobs, and the second matters more than it looks:
 *
 * 1. **Tests.** They assert on what was published, with no broker anywhere near
 *    the suite.
 * 2. **Running with `ENABLE_KAFKA=false`.** The Phase 4 plan expected to keep
 *    the Phase 3 in-process poller alive behind the flag as a second trigger
 *    path. That turned out to be unnecessary: if the bus itself is swappable,
 *    the reaper publishes and the worker consumes exactly as they do with
 *    Kafka, and "no broker" becomes an implementation of the bus rather than a
 *    second code path to maintain. There is one trigger path, always.
 *
 * The delivery guarantee is deliberately the same shape as Kafka's, minus
 * durability: at-least-once, in-process, lost if the process dies. Losing a
 * message is survivable for the same reason a broker outage is -- the
 * stale-`queued` sweep hands the link back.
 */
export function createMemoryBus({ concurrency = 3, logger = console } = {}) {
  const handlers = new Map();
  const queue = [];
  let active = 0;

  /** Every message published this session. Tests read this; nothing else should. */
  const published = [];

  /**
   * Delivery is bounded, because a Kafka consumer's is. kafkajs processes one
   * message at a time per partition, so a three-partition topic gives at most
   * three concurrent handlers. Without a matching bound here, flag-off would
   * fire one fetch per saved link simultaneously -- a regression from Phase 3,
   * and a good way to be rate-limited by a site.
   */
  function pump() {
    while (active < concurrency && queue.length > 0) {
      const { topic, handler, payload } = queue.shift();
      active += 1;

      Promise.resolve()
        .then(() => handler(payload))
        .catch((error) => {
          // A failing handler must not take down the publisher, exactly as a
          // poison message must not stall a partition.
          logger.error?.(`[events] ${topic}: handler failed:`, error.message);
        })
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  return {
    published,

    async start() {},

    async stop() {
      handlers.clear();
      queue.length = 0;
    },

    async publish(topic, key, payload) {
      published.push({ topic, key: String(key), payload });

      // Queued rather than awaited, so a publisher is never blocked by a
      // consumer -- the same decoupling the broker gives.
      for (const handler of handlers.get(topic) ?? []) {
        queue.push({ topic, handler, payload });
      }

      pump();
    },

    async subscribe({ topic, handler }) {
      if (!handlers.has(topic)) handlers.set(topic, []);
      handlers.get(topic).push(handler);
    },

    /** Test helper: resolves once every queued delivery has settled. */
    async drain() {
      while (queue.length > 0 || active > 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}
