import { TOPICS } from '../events/topics.js';
import {
  buildEmbeddingInput,
  embedLink as callProvider,
  embeddingFingerprint,
  hasEnoughToEmbed,
} from '../services/embedding.js';
import { reserveEmbedding } from '../services/usage.js';
import { createDrain } from './drain.js';
import {
  claimForEmbedding,
  completeEmbedding,
  confirmEmbedding,
  deferEmbedding,
  failEmbedding,
  skipEmbedding,
} from './embeddingQueue.js';

/**
 * Consumes `link.enriched` and turns a bookmark into a point in vector space,
 * which is what lets it be found by description rather than by words.
 *
 * `link.enriched` was published by the enrichment worker from the moment Phase 5
 * shipped, with nothing consuming it, precisely so that this could be added
 * without touching that worker. The event was the seam; this is the thing it
 * was left for.
 *
 * Subscribing to `link.enriched` rather than `metadata.extracted` is the choice
 * that decides embedding quality. The summary is the single most useful line of
 * the input -- it is a sentence written to describe the page to someone who
 * half remembers it, which is exactly the query this has to match -- and
 * embedding before enrichment has written it means embedding without it. Links
 * that never reach `link.enriched` (no API key, nothing to summarise, a failed
 * call) are not lost: the reaper sweeps `pending` embeddings directly.
 */

export function createEmbeddingWorker({
  bus,
  embed = callProvider,
  reserveBudget = reserveEmbedding,
  logger = console,
} = {}) {
  const drain = createDrain();

  /**
   * Handles one `link.enriched` event.
   *
   * Returns whether work was done, which is how the tests make redelivery
   * visible: a second delivery of the same event returns false because the
   * claim matches nothing.
   */
  async function runOne({ linkId }) {
    const link = await claimForEmbedding(linkId);

    // Already embedded, already skipped, or claimed by another consumer. The
    // first of the two cost controls, and the one that stops a redelivered
    // event billing anything at all.
    if (!link) return false;

    const input = buildEmbeddingInput(link);

    // A vector built from a domain name alone describes nothing and would sit
    // beside every other bookmark from that host, dragging them into results
    // they do not belong in. Not embedding is the honest answer, and the link
    // is still perfectly findable by keyword.
    if (!hasEnoughToEmbed(input)) {
      await skipEmbedding(link, 'Not enough information to embed');
      return true;
    }

    const fingerprint = embeddingFingerprint(input);

    // The second cost control, and the one the claim cannot provide. The save
    // hook returns a link to `pending` whenever a searchable field is written,
    // which includes enrichment producing a summary identical to the one
    // already there. Buying a byte-for-byte identical vector is pure waste.
    if (link.embeddingFingerprint === fingerprint && link.embedding?.length) {
      await confirmEmbedding(link);
      return true;
    }

    // The last gate before money is spent, in the same order as enrichment's:
    // after the claim, so a redelivered event cannot consume budget for work it
    // will not do, and after the skip and fingerprint checks, so links that
    // were never going to be charged are not counted against a ceiling.
    const budget = await reserveBudget();

    if (!budget.allowed) {
      // Back to `pending`, not `skipped`: the budget clears at midnight and
      // these links are owed an attempt, not a verdict.
      await deferEmbedding(link, 'Daily embedding limit reached; will retry');
      logger.warn?.(`[embedding] daily limit of ${budget.limit} reached, deferring ${link.id}`);
      return true;
    }

    try {
      // The call's own deadline lives in `services/embedding.js`, where it can
      // cancel the request and raise a correctly classified timeout.
      const { vector } = await embed(input);

      await completeEmbedding(link, { vector, fingerprint });

      await bus.publish(TOPICS.EMBEDDING_CREATED, link.id, {
        linkId: link.id,
        userId: link.userId.toString(),
        occurredAt: new Date().toISOString(),
      });

      return true;
    } catch (error) {
      const { terminal } = await failEmbedding(link, error);

      // A rate limit or a provider blip is normal operation, not an incident,
      // and the user never sees any of it: the bookmark still works and is
      // still findable by keyword.
      logger.warn?.(`[embedding] ${link.id} (${link.domain}): ${error.message}`);

      if (terminal) {
        await bus.publish(TOPICS.PROCESSING_FAILED, link.id, {
          linkId: link.id,
          userId: link.userId.toString(),
          stage: 'embedding',
          reason: link.embeddingError,
          occurredAt: new Date().toISOString(),
        });
      }

      // Not rethrown, for the reason the other two workers give: the failure is
      // already recorded on the document, and throwing would redeliver forever
      // and block every later message on the partition.
      return true;
    }
  }

  /** The subscribed handler. Declines new work while draining. */
  async function handle(payload) {
    if (drain.draining) return false;
    return drain.track(() => runOne(payload));
  }

  return {
    handle,

    async start() {
      await bus.subscribe({
        topic: TOPICS.LINK_ENRICHED,
        groupId: 'embedding-worker',
        handler: handle,
      });
    },

    /** Waits for the call in flight, so its vector is written, not wasted. */
    async stop() {
      await drain.drain();
    },
  };
}
