import { Link } from '../models/Link.js';
import { EmbeddingError } from '../services/embeddingError.js';

/**
 * The embedding state machine, deliberately the same shape as `linkQueue.js`
 * and `enrichmentQueue.js`.
 *
 * ```
 * pending --reaper publishes--> queued --consumer claims--> processing --> done
 *    ^                            |                             |            |
 *    +-- lease expired -----------+                             +--> skipped |
 *    +-- retryable failure, backoff not spent ------------------ +--> failed  |
 *    +-- the text it describes changed (models/Link.js save hook) -----------+
 * ```
 *
 * That last arrow is the one the other two machines do not have, and it is
 * what makes the vector track the document: editing a title or writing a
 * summary sends a `done` link back to `pending`, and the link stays searchable
 * by its existing vector until the new one is written.
 *
 * A third near-copy of the same lease bookkeeping is a real cost, and it was
 * weighed. Folding the three into one generic machine would mean one function
 * taking a field-name prefix and a status enum, which reads worse and makes
 * every stage-specific rule -- the enrichment grace period, the
 * `processingStatus: 'ready'` gate, the fingerprint check below -- a
 * conditional inside shared code. The stages differ in exactly the places that
 * matter.
 *
 * Nothing here imports Kafka, and nothing here imports the OpenAI SDK.
 */

/** Attempts, including the first. Matches the other two stages. */
export const MAX_EMBEDDING_ATTEMPTS = 3;

/** Backoff ladder indexed by attempts already spent, as in the other queues. */
export const EMBEDDING_RETRY_DELAYS_MS = [0, 30_000, 120_000];

/** A `queued` link older than this never reached a consumer. */
export const EMBEDDING_QUEUED_LEASE_MS = 60_000;

/** A claim older than this belonged to a process that died mid-call. */
export const EMBEDDING_PROCESSING_LEASE_MS = 2 * 60_000;

/**
 * How long the reaper leaves a link alone before publishing it for embedding.
 *
 * Longer than the enrichment grace, and for an extra reason on top of not
 * racing the live `link.enriched` message. A link's text changes twice in
 * quick succession during normal processing -- extraction writes the title and
 * description, then enrichment writes the summary and tags -- and each of those
 * saves sends the link back to `pending`. Embedding after the first would buy a
 * vector built from half the input and then immediately pay for a second one.
 * Waiting until the text has settled costs nothing and halves the bill.
 */
export const EMBEDDING_QUEUE_GRACE_MS = 2 * 60_000;

/** Builds the "waited long enough" half of the reaper's claim filter. */
function readyToAttempt(now) {
  return EMBEDDING_RETRY_DELAYS_MS.map((delay, attempts) =>
    attempts === 0
      ? // `$in: [null, 0]` for the reason the other queues give: a link saved
        // before this field existed has no `embeddingAttempts` at all, and
        // Mongo will not match a missing field against 0.
        { embeddingAttempts: { $in: [null, 0] } }
      : {
          embeddingAttempts: attempts,
          embeddingStartedAt: { $lte: new Date(now.getTime() - delay) },
        },
  );
}

/**
 * Takes the oldest link whose embedding is due, and marks it as published.
 *
 * Not gated on `processingStatus: 'ready'`, which is the one place this differs
 * from the enrichment claim. Extraction failing does not mean there is nothing
 * to embed: the user's own title survives it, and so does anything the browser
 * extension captured from a page this server cannot reach. `hasEnoughToEmbed`
 * makes that judgement per link, on the text itself, rather than inferring it
 * from a status.
 */
export async function claimForEmbeddingQueue(now = new Date()) {
  const settled = new Date(now.getTime() - EMBEDDING_QUEUE_GRACE_MS);

  return Link.findOneAndUpdate(
    {
      // `null` matches a *missing* field as well as an explicit one, and that
      // is the only thing that makes every link saved before this phase
      // eligible. Mongoose returns the schema default when such a document is
      // read, so it looks `pending` in code while being invisible to a query
      // for `pending` -- the same trap `embeddingAttempts: {$in: [null, 0]}`
      // sidesteps below, and the reason no backfill migration is needed here.
      embeddingStatus: { $in: ['pending', null] },
      $and: [
        // Against `updatedAt`, not `savedAt` or `processedAt`: what must have
        // settled is the *text*, and `updatedAt` is the only field that moves
        // whenever any of it does.
        { updatedAt: { $lte: settled } },
        { $or: readyToAttempt(now) },
      ],
    },
    { $set: { embeddingStatus: 'queued', embeddingQueuedAt: now } },
    { sort: { savedAt: 1 }, new: true },
  );
}

/** Undoes a queue claim whose publish threw. */
export async function releaseEmbeddingToPending(linkId) {
  await Link.updateOne(
    { _id: linkId, embeddingStatus: 'queued' },
    { $set: { embeddingStatus: 'pending', embeddingQueuedAt: null } },
  );
}

/**
 * Takes a link for actual work, given an id that arrived in an event.
 *
 * As with enrichment, a redelivered event costs money rather than one wasted
 * request, and this single query is the whole idempotency story: a second
 * delivery for a link already `done`, `skipped` or in flight matches nothing
 * and bills nothing.
 *
 * `+embedding +capture` because both are `select: false` and both are needed
 * here -- the capture is embedding input, and the existing vector is what the
 * fingerprint check below is comparing against.
 */
export async function claimForEmbedding(linkId) {
  return Link.findOneAndUpdate(
    // `null` again, for links from before this phase: the reaper's sweep can
    // publish one, and the claim that follows must be able to take it.
    { _id: linkId, embeddingStatus: { $in: ['queued', 'pending', null] } },
    {
      $set: { embeddingStatus: 'processing', embeddingStartedAt: new Date() },
      $inc: { embeddingAttempts: 1 },
    },
    { new: true },
  ).select('+embedding +capture');
}

/**
 * Marks a claimed link as already embedded, without calling anything.
 *
 * The second cost control after the claim, and it catches what the claim
 * cannot. Enrichment re-running and producing an identical summary is ordinary,
 * and so is any save that touches a searchable field without changing it: both
 * send the link back to `pending` and both would otherwise buy a vector byte
 * for byte identical to the one already stored.
 */
export async function confirmEmbedding(link) {
  link.embeddingStatus = 'done';
  link.embeddingError = '';
  link.embeddingQueuedAt = null;

  await link.save();
  return link;
}

/** Writes a new vector and the fingerprint of the text it was built from. */
export async function completeEmbedding(link, { vector, fingerprint }) {
  link.embedding = vector;
  link.embeddingFingerprint = fingerprint;
  link.embeddingStatus = 'done';
  link.embeddingError = '';
  link.embeddedAt = new Date();
  link.embeddingQueuedAt = null;

  await link.save();
  return link;
}

/**
 * Ends embedding without calling anything.
 *
 * Terminal and not a failure: no key configured, or a link with so little text
 * that a vector built from it would describe nothing. The link stays fully
 * findable by keyword, which is why this is not an error state.
 *
 * Not permanent in practice -- the save hook returns a link to `pending` the
 * moment its text changes -- so a bookmark skipped for having only a URL starts
 * embedding as soon as extraction gives it a title.
 */
export async function skipEmbedding(link, reason) {
  link.embeddingStatus = 'skipped';
  link.embeddingError = reason;
  link.embeddingQueuedAt = null;

  await link.save();
  return link;
}

/**
 * Hands a claimed link back untouched, for a refusal that is about us rather
 * than about the link.
 *
 * The daily ceiling, exactly as in `deferEnrichment`. A spent budget is a
 * condition of today and clears at midnight, so `skipped` would permanently
 * abandon a queue that merely needed to wait -- and the attempt is given back
 * because the retry ladder exists to stop hammering something that is failing,
 * which this link has not done.
 */
export async function deferEmbedding(link, reason) {
  link.embeddingStatus = 'pending';
  link.embeddingError = reason;
  link.embeddingQueuedAt = null;
  link.embeddingAttempts = Math.max(0, link.embeddingAttempts - 1);

  await link.save();
  return link;
}

/**
 * Records a failure, deciding whether it is worth another go.
 *
 * The same policy as the other two stages, read off the classification
 * `services/embedding.js` already made.
 */
export async function failEmbedding(link, error) {
  const isKnown = error instanceof EmbeddingError;
  const retryable = isKnown && error.retryable;
  const exhausted = link.embeddingAttempts >= MAX_EMBEDDING_ATTEMPTS;
  const terminal = !retryable || exhausted;

  link.embeddingStatus = terminal ? 'failed' : 'pending';
  link.embeddingError = isKnown ? error.message : 'Could not build an embedding';
  link.embeddingQueuedAt = null;

  await link.save();
  return { terminal };
}

/** Hands back links whose lease expired, in both directions. */
export async function reclaimStaleEmbedding(now = new Date()) {
  const lostMessages = await Link.updateMany(
    {
      embeddingStatus: 'queued',
      embeddingQueuedAt: { $lte: new Date(now.getTime() - EMBEDDING_QUEUED_LEASE_MS) },
    },
    { $set: { embeddingStatus: 'pending', embeddingQueuedAt: null } },
  );

  const abandonedWork = await Link.updateMany(
    {
      embeddingStatus: 'processing',
      embeddingStartedAt: { $lte: new Date(now.getTime() - EMBEDDING_PROCESSING_LEASE_MS) },
    },
    [
      {
        $set: {
          embeddingStatus: {
            $cond: [{ $gte: ['$embeddingAttempts', MAX_EMBEDDING_ATTEMPTS] }, 'failed', 'pending'],
          },
          embeddingError: 'Embedding was interrupted',
          embeddingQueuedAt: null,
        },
      },
    ],
  );

  return {
    lostMessages: lostMessages.modifiedCount,
    abandonedWork: abandonedWork.modifiedCount,
  };
}
