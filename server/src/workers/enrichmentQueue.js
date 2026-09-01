import { Link } from '../models/Link.js';
import { EnrichmentError } from '../services/enrichmentError.js';
import { mergeTags, normalizeTags } from '../utils/tags.js';

/**
 * The enrichment state machine, deliberately a near-copy of `linkQueue.js`.
 *
 * ```
 * pending --reaper publishes--> queued --consumer claims--> processing --> done
 *    ^                            |                             |            |
 *    +-- lease expired -----------+                             +--> skipped |
 *    +-- retryable failure, backoff not spent ------------------ +--> failed  |
 * ```
 *
 * It is a separate module rather than more branches inside `linkQueue.js`
 * because the two machines advance independently: a link is `ready` the moment
 * extraction finishes, whatever enrichment is doing, and that separation is the
 * whole of §8 -- a link whose enrichment failed is still a perfectly good
 * bookmark and must never be shown as broken.
 *
 * Nothing here imports Kafka, and nothing here imports the OpenAI SDK.
 */

/** Attempts, including the first. Matches extraction; three rides out a blip. */
export const MAX_ENRICHMENT_ATTEMPTS = 3;

/** Backoff ladder indexed by attempts already spent, as in `linkQueue.js`. */
export const ENRICHMENT_RETRY_DELAYS_MS = [0, 30_000, 120_000];

/** A `queued` link older than this never reached a consumer. */
export const ENRICHMENT_QUEUED_LEASE_MS = 60_000;

/**
 * A claim older than this belonged to a process that died mid-call.
 * Comfortably longer than the request deadline below, so a slow model is never
 * stolen from itself.
 */
export const ENRICHMENT_PROCESSING_LEASE_MS = 3 * 60_000;

/**
 * How long the reaper leaves a freshly extracted link alone before republishing
 * it.
 *
 * The metadata worker publishes `metadata.extracted` itself, and the live
 * message is what normally starts enrichment. Without this grace the reaper
 * would race that message on its very next sweep and publish a duplicate for
 * every link in the system -- harmless, because the claim is idempotent, but
 * pure noise. The sweep is a recovery mechanism; it should only act once the
 * live path has visibly not worked.
 */
export const ENRICHMENT_QUEUE_GRACE_MS = 90_000;

/** Builds the "waited long enough" half of the reaper's claim filter. */
function readyToAttempt(now) {
  return ENRICHMENT_RETRY_DELAYS_MS.map((delay, attempts) =>
    attempts === 0
      ? // `$in: [null, 0]` for the same reason extraction needs it: every link
        // saved before this field existed has no `enrichmentAttempts` at all,
        // and Mongo will not match a missing field against 0. Written as `0`,
        // no existing bookmark would ever be enriched.
        { enrichmentAttempts: { $in: [null, 0] } }
      : {
          enrichmentAttempts: attempts,
          enrichmentStartedAt: { $lte: new Date(now.getTime() - delay) },
        },
  );
}

/**
 * Takes the oldest link whose enrichment is due, and marks it as published.
 *
 * Scoped to `processingStatus: 'ready'` on purpose. A link extraction gave up
 * on has no title and no description, so there is nothing to enrich; leaving it
 * at `pending` costs nothing and it becomes eligible the moment a user retries
 * extraction successfully.
 */
export async function claimForEnrichmentQueue(now = new Date()) {
  return Link.findOneAndUpdate(
    {
      processingStatus: 'ready',
      enrichmentStatus: 'pending',
      // The grace above, expressed against the moment extraction finished.
      // `null` covers links from before that field was written.
      $and: [
        {
          $or: [
            { processedAt: null },
            { processedAt: { $lte: new Date(now.getTime() - ENRICHMENT_QUEUE_GRACE_MS) } },
          ],
        },
        { $or: readyToAttempt(now) },
      ],
    },
    { $set: { enrichmentStatus: 'queued', enrichmentQueuedAt: now } },
    { sort: { savedAt: 1 }, new: true },
  );
}

/** Undoes a queue claim whose publish threw. */
export async function releaseEnrichmentToPending(linkId) {
  await Link.updateOne(
    { _id: linkId, enrichmentStatus: 'queued' },
    { $set: { enrichmentStatus: 'pending', enrichmentQueuedAt: null } },
  );
}

/**
 * Takes a link for actual work, given an id that arrived in an event.
 *
 * This matters more here than it does for extraction, because a redelivered
 * event costs real money rather than one wasted HTTP request. A second delivery
 * for a link already `done`, `skipped` or in flight matches nothing, claims
 * nothing, returns null, and bills nothing.
 *
 * `pending` is accepted alongside `queued` because a stale-lease sweep may have
 * handed the link back before a slow message arrived; the event is still valid.
 */
export async function claimForEnrichment(linkId) {
  return Link.findOneAndUpdate(
    {
      _id: linkId,
      processingStatus: 'ready',
      enrichmentStatus: { $in: ['queued', 'pending'] },
    },
    {
      $set: { enrichmentStatus: 'processing', enrichmentStartedAt: new Date() },
      $inc: { enrichmentAttempts: 1 },
    },
    { new: true },
  );
}

/**
 * Writes a successful enrichment back.
 *
 * Two provenance rules, and neither is optional:
 *
 * - The summary is only written when the field is still empty, matching the
 *   Phase 3 precedent that a typed value is never overwritten.
 * - Tags are merged, never replaced, and are skipped entirely once
 *   `tagsEditedByUser` is set. The scenario that rule exists for: a user
 *   deletes an auto-tag they dislike, the link is re-enriched later, and the
 *   tag comes back. That is infuriating, and it is the fastest way to make
 *   someone turn the feature off.
 */
export async function completeEnrichment(link, { summary, tags }, { vocabulary = [] } = {}) {
  if (summary && !link.summary) link.summary = summary;

  const autoTags = normalizeTags(tags, { vocabulary });
  link.autoTags = autoTags;

  if (!link.tagsEditedByUser) {
    link.tags = mergeTags(link.tags, autoTags);
  }

  link.enrichmentStatus = 'done';
  link.enrichmentError = '';
  link.enrichedAt = new Date();
  link.enrichmentQueuedAt = null;

  await link.save();
  return link;
}

/**
 * Ends enrichment without calling anything.
 *
 * Terminal and not a failure: no key configured, or nothing worth sending. The
 * distinction is what keeps a fresh clone with no OpenAI account from filling
 * the log with errors about a feature the user never turned on.
 */
export async function skipEnrichment(link, reason) {
  link.enrichmentStatus = 'skipped';
  link.enrichmentError = reason;
  link.enrichedAt = new Date();
  link.enrichmentQueuedAt = null;

  await link.save();
  return link;
}

/**
 * Records a failure, deciding whether it is worth another go.
 *
 * Same policy as extraction, read off the classification `services/enrichment.js`
 * already made: 429, 5xx, connection errors and timeouts go back to `pending`
 * for the backoff ladder; 400 and 404 go straight to `failed`, because
 * retrying a request the provider rejected outright cannot help.
 */
export async function failEnrichment(link, error) {
  const isKnown = error instanceof EnrichmentError;
  const retryable = isKnown && error.retryable;
  const exhausted = link.enrichmentAttempts >= MAX_ENRICHMENT_ATTEMPTS;
  const terminal = !retryable || exhausted;

  link.enrichmentStatus = terminal ? 'failed' : 'pending';
  link.enrichmentError = isKnown ? error.message : 'Could not generate a summary';
  link.enrichmentQueuedAt = null;

  await link.save();
  return { terminal };
}

/** Hands back links whose lease expired, in both directions. */
export async function reclaimStaleEnrichment(now = new Date()) {
  const lostMessages = await Link.updateMany(
    {
      enrichmentStatus: 'queued',
      enrichmentQueuedAt: { $lte: new Date(now.getTime() - ENRICHMENT_QUEUED_LEASE_MS) },
    },
    { $set: { enrichmentStatus: 'pending', enrichmentQueuedAt: null } },
  );

  const abandonedWork = await Link.updateMany(
    {
      enrichmentStatus: 'processing',
      enrichmentStartedAt: {
        $lte: new Date(now.getTime() - ENRICHMENT_PROCESSING_LEASE_MS),
      },
    },
    [
      {
        $set: {
          enrichmentStatus: {
            $cond: [
              { $gte: ['$enrichmentAttempts', MAX_ENRICHMENT_ATTEMPTS] },
              'failed',
              'pending',
            ],
          },
          enrichmentError: 'Enrichment was interrupted',
          enrichmentQueuedAt: null,
        },
      },
    ],
  );

  return {
    lostMessages: lostMessages.modifiedCount,
    abandonedWork: abandonedWork.modifiedCount,
  };
}
