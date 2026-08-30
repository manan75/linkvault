import { TOPICS } from '../events/topics.js';
import { withDeadline } from '../utils/withDeadline.js';
import { claimForQueue, reclaimStale, releaseToPending } from './linkQueue.js';

/**
 * Publishes `link.created` for every bookmark waiting to be processed, and
 * hands back anything whose lease expired.
 *
 * This is the Phase 3 poller with its job changed: it used to fetch pages, now
 * it only publishes. Keeping it is what makes the event pipeline safe.
 *
 * The obvious design -- publish from the API on save -- has a silent failure
 * mode. The link commits to MongoDB, then the publish fails because the broker
 * is down or the process is killed, and the event never exists. The link sits
 * at `pending` forever with nothing logged. Sweeping the database instead makes
 * the `links` collection its own outbox: no outbox table, no Mongo
 * transactions, no relay process.
 */

/**
 * How long a single publish may take before it is written off.
 *
 * Not paranoia. `kafkajs` does not reject when the broker is unreachable -- it
 * retries the seed broker indefinitely, so `producer.send` simply never
 * settles. Without a deadline here that hangs `runOnce` forever, `isTicking`
 * stays true, and the sweep never runs again: a broker outage would stall the
 * pipeline permanently and only an API restart would clear it. Stale-lease
 * recovery would go down with it, which is precisely the thing meant to save us.
 */
const PUBLISH_TIMEOUT_MS = 5_000;

/** How long to stop publishing after a failure, rather than hammering a dead broker. */
const PUBLISH_COOLDOWN_MS = 15_000;

export function createReaper({
  bus,
  intervalMs = 2_000,
  /** Per sweep. Only publishing happens here, so this is not a work limit. */
  batchSize = 50,
  publishTimeoutMs = PUBLISH_TIMEOUT_MS,
  cooldownMs = PUBLISH_COOLDOWN_MS,
  logger = console,
} = {}) {
  let timer = null;
  let isTicking = false;
  let publishPausedUntil = 0;

  /** Claims one link and publishes it. Returns the link, or null if none was due. */
  async function queueOne() {
    const link = await claimForQueue();
    if (!link) return null;

    try {
      await withDeadline(
        bus.publish(TOPICS.LINK_CREATED, link.id, {
          linkId: link.id,
          // Rides along so a consumer can log and scope without a second read.
          // Everything else is deliberately absent: the message carries an id,
          // never a copy of the document.
          userId: link.userId.toString(),
          occurredAt: new Date().toISOString(),
        }),
        publishTimeoutMs,
        `publish did not complete within ${publishTimeoutMs}ms`,
      );

      return link;
    } catch (error) {
      // The status moved but the message did not leave. Put it straight back so
      // the next sweep retries, rather than waiting out the queued lease.
      await releaseToPending(link.id);
      throw error;
    }
  }

  async function runOnce() {
    // Always first, and never behind the publish loop. This is what recovers
    // links stranded by the very outages that stop publishing from working, so
    // it must not share their fate.
    const { lostMessages, abandonedWork } = await reclaimStale();

    if (lostMessages > 0) {
      logger.warn?.(`[reaper] ${lostMessages} link(s) never reached a consumer, requeued`);
    }
    if (abandonedWork > 0) {
      logger.warn?.(`[reaper] ${abandonedWork} abandoned claim(s) recovered`);
    }

    if (Date.now() < publishPausedUntil) return 0;

    let published = 0;

    for (let slot = 0; slot < batchSize; slot += 1) {
      let link;

      try {
        link = await queueOne();
      } catch (error) {
        // Almost always the broker being unreachable. Back off rather than
        // grinding the whole backlog through the same failure; the links stay
        // `pending` and a later sweep picks them up.
        publishPausedUntil = Date.now() + cooldownMs;
        logger.error?.(
          `[reaper] publish failed, pausing for ${cooldownMs / 1000}s: ${error.message}`,
        );
        break;
      }

      if (!link) break;
      published += 1;
    }

    return published;
  }

  async function tick() {
    if (isTicking) return;
    isTicking = true;

    try {
      await runOnce();
    } catch (error) {
      // Only a database failure reaches here; publish errors are handled above.
      logger.error?.('[reaper] sweep failed:', error);
    } finally {
      isTicking = false;
    }
  }

  return {
    runOnce,

    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      // Never a reason to hold the process open for the sweep.
      timer.unref?.();
      tick();
    },

    stop() {
      clearInterval(timer);
      timer = null;
    },

    /**
     * Sweeps now. Called after a save so a new bookmark starts filling in
     * immediately instead of up to `intervalMs` later. A no-op when the reaper
     * was never started, which is how the test suite stays deterministic.
     */
    nudge() {
      if (timer) setImmediate(tick);
    },
  };
}
