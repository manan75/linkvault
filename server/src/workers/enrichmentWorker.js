import { TOPICS } from '../events/topics.js';
import {
  buildEnrichmentInput,
  enrichLink as callProvider,
  hasEnoughToEnrich,
} from '../services/enrichment.js';
import { listTags } from '../services/linkService.js';
import {
  claimForEnrichment,
  completeEnrichment,
  failEnrichment,
  skipEnrichment,
} from './enrichmentQueue.js';

/**
 * Consumes `metadata.extracted` and turns a filled-in bookmark into one the
 * user can find by describing it.
 *
 * The same claim → work → complete-or-fail shape as the metadata worker, with
 * two differences that both come from the work costing money:
 *
 * - the skip conditions are checked *after* the claim but *before* the call, so
 *   a link with nothing to say never bills anything, and
 * - a redelivered event is stopped by the claim rather than by the provider.
 */

export function createEnrichmentWorker({
  bus,
  enrich = callProvider,
  loadVocabulary = listTags,
  logger = console,
} = {}) {
  /**
   * Handles one `metadata.extracted` event.
   *
   * Returns whether work was done, which is how the tests make redelivery
   * visible: a second delivery of the same event returns false because the
   * claim matches nothing.
   */
  async function handle({ linkId }) {
    const link = await claimForEnrichment(linkId);

    // Already enriched, already skipped, or claimed by another consumer. This
    // single query is the entire idempotency story, and here it is also the
    // cost control: no second claim, no second bill.
    if (!link) return false;

    const input = buildEnrichmentInput(link);

    // §4: the model sees the title and the description or nothing at all. When
    // that is nothing, do not ask -- it costs money and it is the strongest
    // temptation there is to invent a summary from the domain name.
    if (!hasEnoughToEnrich(input)) {
      await skipEnrichment(link, 'Not enough page information to summarise');
      return true;
    }

    try {
      // The user's own tags, which is what keeps the vocabulary from drifting
      // into `js` / `javascript` / `JavaScript`. Read per link rather than
      // cached because it grows as the user's library does, and a stale
      // vocabulary reintroduces exactly the drift it exists to prevent.
      const vocabulary = (await loadVocabulary(link.userId)).map((tag) => tag.name);

      // The call's own deadline lives in `services/enrichment.js`, where it can
      // cancel the request and raise a correctly classified timeout.
      const { summary, tags } = await enrich({ ...input, vocabulary });

      await completeEnrichment(link, { summary, tags }, { vocabulary });

      await bus.publish(TOPICS.LINK_ENRICHED, link.id, {
        linkId: link.id,
        userId: link.userId.toString(),
        occurredAt: new Date().toISOString(),
      });

      return true;
    } catch (error) {
      const { terminal } = await failEnrichment(link, error);

      // A rate limit or a provider blip is normal operation, not an incident --
      // and §8 means the user never sees any of this: the bookmark still works.
      logger.warn?.(`[enrichment] ${link.id} (${link.domain}): ${error.message}`);

      if (terminal) {
        await bus.publish(TOPICS.PROCESSING_FAILED, link.id, {
          linkId: link.id,
          userId: link.userId.toString(),
          stage: 'enrichment',
          reason: link.enrichmentError,
          occurredAt: new Date().toISOString(),
        });
      }

      // Not rethrown, for the reason the metadata worker gives: the failure is
      // already recorded on the document, and throwing would redeliver forever
      // and block every later message on the partition.
      return true;
    }
  }

  return {
    handle,

    async start() {
      await bus.subscribe({
        topic: TOPICS.METADATA_EXTRACTED,
        groupId: 'enrichment-worker',
        handler: handle,
      });
    },
  };
}
