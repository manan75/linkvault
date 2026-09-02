import { TOPICS } from '../events/topics.js';
import { withDeadline } from '../utils/withDeadline.js';
import {
  claimForEnrichmentQueue,
  reclaimStaleEnrichment,
  releaseEnrichmentToPending,
} from './enrichmentQueue.js';
import { claimForQueue, reclaimStale, releaseToPending } from './linkQueue.js';

/**
 * Publishes `link.created` for every bookmark waiting to be processed and
 * `metadata.extracted` for every one still waiting to be enriched, and hands
 * back anything whose lease expired.
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
 *
 * Phase 5 added the second stage to the same sweep rather than a second reaper.
 * It is the same claim-then-publish against the same collection, the enrichment
 * half is normally dormant because the live `metadata.extracted` message does
 * the work, and one loop means one place where a stalled pipeline is visible.
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
  /**
   * Whether to sweep for links awaiting enrichment. Off means they simply wait
   * at `pending`: with no key configured there is no consumer, and republishing
   * into a topic nobody reads would churn every link in the library through the
   * queued lease forever. They are picked up whenever a key appears.
   */
  enrichmentEnabled = true,
  /**
   * Whether there is budget left to enrich anything today.
   *
   * Injected rather than imported so the reaper keeps knowing nothing about
   * what enrichment costs. It exists because the ceiling has to be enforced on
   * the *producer* side as well as the consumer side: the worker refusing to
   * spend is what protects the bill, but on its own it would leave every link
   * awaiting enrichment cycling through publish, claim, refuse and release on
   * every lease expiry -- a backlog grinding out database writes all night to
   * rediscover the same answer. Not feeding the pipeline is cheaper than
   * repeatedly declining to feed on it.
   */
  hasEnrichmentBudget = async () => true,
  logger = console,
} = {}) {
  let timer = null;
  let isTicking = false;
  let publishPausedUntil = 0;
  let budgetExhausted = false;

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

  /** Claims one link awaiting enrichment and republishes `metadata.extracted`. */
  async function queueOneForEnrichment() {
    const link = await claimForEnrichmentQueue();
    if (!link) return null;

    try {
      await withDeadline(
        // Deliberately the same event the metadata worker emits, not a new
        // topic. The consumer cannot tell a recovery from a first delivery and
        // should not have to: its claim makes both cases identical.
        bus.publish(TOPICS.METADATA_EXTRACTED, link.id, {
          linkId: link.id,
          userId: link.userId.toString(),
          occurredAt: new Date().toISOString(),
        }),
        publishTimeoutMs,
        `publish did not complete within ${publishTimeoutMs}ms`,
      );

      return link;
    } catch (error) {
      await releaseEnrichmentToPending(link.id);
      throw error;
    }
  }

  /**
   * Publishes up to `batchSize` links from one stage, pausing the whole reaper
   * on the first failure.
   */
  async function publishBatch(claimAndPublish) {
    let published = 0;

    for (let slot = 0; slot < batchSize; slot += 1) {
      let link;

      try {
        link = await claimAndPublish();
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

  async function runOnce() {
    // Always first, and never behind the publish loop. This is what recovers
    // links stranded by the very outages that stop publishing from working, so
    // it must not share their fate.
    const [extraction, enrichment] = await Promise.all([
      reclaimStale(),
      enrichmentEnabled ? reclaimStaleEnrichment() : { lostMessages: 0, abandonedWork: 0 },
    ]);

    const lostMessages = extraction.lostMessages + enrichment.lostMessages;
    const abandonedWork = extraction.abandonedWork + enrichment.abandonedWork;

    if (lostMessages > 0) {
      logger.warn?.(`[reaper] ${lostMessages} link(s) never reached a consumer, requeued`);
    }
    if (abandonedWork > 0) {
      logger.warn?.(`[reaper] ${abandonedWork} abandoned claim(s) recovered`);
    }

    if (Date.now() < publishPausedUntil) return 0;

    // Extraction first: enrichment has nothing to work with until it has run,
    // and a backlog of un-extracted links is the more visible stall.
    let published = await publishBatch(queueOne);

    if (enrichmentEnabled && Date.now() >= publishPausedUntil) {
      const funded = await hasEnrichmentBudget();

      // Logged on the transition rather than on every sweep, which at a
      // two-second interval would be roughly forty thousand identical lines
      // between the budget running out and midnight.
      if (!funded && !budgetExhausted) {
        logger.warn?.('[reaper] daily enrichment budget spent, holding links until it resets');
      } else if (funded && budgetExhausted) {
        logger.log?.('[reaper] enrichment budget available again, resuming');
      }

      budgetExhausted = !funded;

      if (funded) published += await publishBatch(queueOneForEnrichment);
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
