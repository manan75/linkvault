import { Link } from '../models/Link.js';
import { FetchError } from '../services/safeFetch.js';

/**
 * The link processing state machine, with no idea how events travel.
 *
 * ```
 * pending --reaper publishes--> queued --consumer claims--> processing --> ready
 *    ^                            |                             |            |
 *    +-- lease expired -----------+                             |            |
 *    +-- retryable failure, backoff not spent ------------------ +            |
 *                                                               +--> failed  |
 * ```
 *
 * Kept separate from both the reaper and the consumer because they share every
 * transition, and because it is what Phase 5's enrichment worker will reuse
 * rather than reinvent. Nothing here imports Kafka.
 */

/** Attempts, including the first. Three is enough to ride out a blip. */
export const MAX_ATTEMPTS = 3;

/**
 * How long a link waits after each failed attempt before it is picked up again
 * -- exponential backoff written as a ladder, because the delay depends on the
 * document's own attempt count and this keeps it expressible as a plain query
 * rather than an aggregation.
 */
export const RETRY_DELAYS_MS = [0, 30_000, 120_000];

/**
 * A `queued` link older than this never reached a consumer. Short, because
 * nothing is actually being worked on during this window -- the message is
 * either delivered within seconds or it is lost.
 */
export const QUEUED_LEASE_MS = 60_000;

/**
 * A `processing` claim older than this belonged to a process that died
 * mid-fetch. Comfortably longer than the fetch timeout, so a slow site is never
 * stolen from itself.
 */
export const PROCESSING_LEASE_MS = 2 * 60_000;

const FIELDS_FROM_PAGE = ['title', 'description', 'author', 'favicon', 'thumbnail'];

/** Builds the "waited long enough" half of the reaper's claim filter. */
function readyToAttempt(now) {
  return RETRY_DELAYS_MS.map((delay, attempts) =>
    attempts === 0
      ? // `$in: [null, 0]` rather than `0`: links saved before this field
        // existed have no `processingAttempts` at all, and Mongo does not match
        // a missing field against 0. Written as `0` they would never be
        // claimed, and every bookmark from Phase 2 would sit at `pending`
        // forever. A schema default is not a migration.
        { processingAttempts: { $in: [null, 0] } }
      : {
          processingAttempts: attempts,
          processingStartedAt: { $lte: new Date(now.getTime() - delay) },
        },
  );
}

/**
 * Takes the oldest link that is due, and marks it as published.
 *
 * The status write happens *before* the publish so the reaper cannot pick the
 * same link up on its next sweep. If the publish then fails, `releaseToPending`
 * puts it straight back.
 */
export async function claimForQueue() {
  const now = new Date();

  return Link.findOneAndUpdate(
    { processingStatus: 'pending', $or: readyToAttempt(now) },
    { $set: { processingStatus: 'queued', queuedAt: now } },
    { sort: { savedAt: 1 }, new: true },
  );
}

/** Undoes a queue claim whose publish threw. */
export async function releaseToPending(linkId) {
  await Link.updateOne(
    { _id: linkId, processingStatus: 'queued' },
    { $set: { processingStatus: 'pending', queuedAt: null } },
  );
}

/**
 * Takes a link for actual work, given an id that arrived in an event.
 *
 * This is the whole idempotency story, and Principle 4 gets satisfied for free:
 * Kafka is at-least-once, and a redelivered event for a link that is already
 * `ready` matches nothing, claims nothing, and returns null. No deduplication
 * table, no processed-message log.
 *
 * `pending` is accepted alongside `queued` because a stale-lease sweep may have
 * returned the link before a slow message arrived; the event is still valid.
 *
 * The attempt is counted here rather than at queue time, so a lost message
 * costs a site nothing, while a consumer that dies mid-fetch still burns an
 * attempt and a link that reliably crashes the worker cannot loop forever.
 */
export async function claimForProcessing(linkId) {
  return Link.findOneAndUpdate(
    { _id: linkId, processingStatus: { $in: ['queued', 'pending'] } },
    {
      $set: { processingStatus: 'processing', processingStartedAt: new Date() },
      $inc: { processingAttempts: 1 },
    },
    { new: true },
  );
}

/** Writes a successful extraction back, and records that nothing was found. */
export async function completeLink(link, fields) {
  // User input wins: extraction only fills a field that is still empty. A user
  // who typed a title has made it non-empty, so this skips it.
  for (const field of FIELDS_FROM_PAGE) {
    if (!link[field] && fields?.[field]) link[field] = fields[field];
  }

  link.processingStatus = 'ready';
  link.processingError = '';
  link.processedAt = new Date();
  link.queuedAt = null;

  await link.save();
  return link;
}

/**
 * Records a failure, deciding whether it is worth another go.
 *
 * Transient causes (timeout, reset, 429, 5xx, resolver trouble) go back to
 * `pending`, where the backoff ladder governs when the reaper republishes them
 * -- which is why no retry topic is needed. Permanent ones (404, blocked
 * address, non-HTML, unparseable) go straight to `failed`.
 *
 * Returns whether this was terminal, so the caller knows to publish
 * `link.processing.failed`.
 */
export async function failLink(link, error) {
  const isKnown = error instanceof FetchError;
  const retryable = isKnown && error.retryable;
  const exhausted = link.processingAttempts >= MAX_ATTEMPTS;
  const terminal = !retryable || exhausted;

  link.processingStatus = terminal ? 'failed' : 'pending';
  link.processingError = isKnown ? error.message : 'Could not read that page';
  link.queuedAt = null;

  await link.save();
  return { terminal };
}

/**
 * Hands back links whose lease expired, in both directions.
 *
 * Without this, a broker outage strands links at `queued` and a crash during a
 * fetch strands them at `processing` -- in both cases forever, because nothing
 * else will ever match them.
 */
export async function reclaimStale(now = new Date()) {
  // A message that never arrived costs the site nothing: straight back to
  // pending with the attempt count untouched.
  const lostMessages = await Link.updateMany(
    {
      processingStatus: 'queued',
      queuedAt: { $lte: new Date(now.getTime() - QUEUED_LEASE_MS) },
    },
    { $set: { processingStatus: 'pending', queuedAt: null } },
  );

  // A claim that died mid-fetch already burned its attempt, so it fails once
  // the budget is spent rather than retrying forever.
  const abandonedWork = await Link.updateMany(
    {
      processingStatus: 'processing',
      processingStartedAt: { $lte: new Date(now.getTime() - PROCESSING_LEASE_MS) },
    },
    [
      {
        $set: {
          processingStatus: {
            $cond: [{ $gte: ['$processingAttempts', MAX_ATTEMPTS] }, 'failed', 'pending'],
          },
          processingError: 'Processing was interrupted',
          queuedAt: null,
        },
      },
    ],
  );

  return {
    lostMessages: lostMessages.modifiedCount,
    abandonedWork: abandonedWork.modifiedCount,
  };
}
