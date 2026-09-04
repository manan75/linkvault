import { TOPICS } from '../events/topics.js';
import { fieldsFromCapture } from '../services/captureParser.js';
import { decodeHtml, parseMetadata } from '../services/metadataParser.js';
import { safeFetch } from '../services/safeFetch.js';
import { createDrain } from './drain.js';
import { claimForProcessing, completeLink, failLink } from './linkQueue.js';

/**
 * Consumes `link.created` and turns a saved URL into a filled-in bookmark.
 *
 * This is a consumer now rather than a poller, which is the entire change
 * Phase 4 makes to extraction. `handle` is the same claim → process →
 * complete-or-fail sequence the Phase 3 poller ran; only what calls it moved.
 * Everything below the claim -- the guarded fetch, the parser, the retry policy
 * -- is untouched.
 *
 * One branch was added for the extension: a link that arrived carrying a
 * capture already has its fields and skips the fetch entirely. The branch is
 * here rather than in `saveLink`, even though there is no I/O to wait for and
 * completing synchronously would be tempting. Doing it there would duplicate
 * `completeLink`, fork the state machine, and break `CLAUDE.md` principle 2.
 * Here there is still one completion path, one lease and one retry policy --
 * the capture case simply does not call the network.
 */

const isHtml = (contentType) => /^\s*(text\/html|application\/xhtml\+xml)/i.test(contentType);

export function createMetadataWorker({
  bus,
  fetchPage = safeFetch,
  logger = console,
} = {}) {
  const drain = createDrain();

  /**
   * Fetches the page and reads what it declares about itself.
   *
   * Returns null rather than throwing for a PDF or an image: there is simply
   * nothing to parse, and saying so beats leaving the link retrying a page it
   * can never read.
   */
  async function fetchAndParse(link) {
    const response = await fetchPage(link.url);

    if (!isHtml(response.contentType)) return null;

    return parseMetadata(decodeHtml(response.body, response.contentType), {
      finalUrl: response.url,
    });
  }

  /**
   * Handles one `link.created` event.
   *
   * Returns whether work was done, which tests assert on and which makes
   * redelivery visible: a second delivery of the same event returns false
   * because the claim matches nothing.
   */
  async function runOne({ linkId }) {
    const link = await claimForProcessing(linkId);

    // Already processed, or claimed by another consumer. Kafka is at-least-once
    // and this is what makes that harmless.
    if (!link) return false;

    try {
      // The extension already saw this page, from the user's own address and
      // their own session. That is not an optimisation: production returns 429
      // for YouTube and 403 for LeetCode to this server whatever it sends, and
      // no server-side technique reaches a page behind a login at all. When a
      // capture is present it is the better source, not the fallback.
      const fields = link.capture
        ? fieldsFromCapture(link.capture)
        : await fetchAndParse(link);

      await completeLink(link, fields);

      await bus.publish(TOPICS.METADATA_EXTRACTED, link.id, {
        linkId: link.id,
        userId: link.userId.toString(),
        occurredAt: new Date().toISOString(),
      });

      return true;
    } catch (error) {
      const { terminal } = await failLink(link, error);

      // A site being down is normal operation, not an incident.
      logger.warn?.(`[metadata] ${link.id} (${link.domain}): ${error.message}`);

      if (terminal) {
        await bus.publish(TOPICS.PROCESSING_FAILED, link.id, {
          linkId: link.id,
          userId: link.userId.toString(),
          stage: 'metadata',
          reason: link.processingError,
          occurredAt: new Date().toISOString(),
        });
      }

      // Deliberately not rethrown. The failure is already recorded durably on
      // the document, and throwing would make the consumer redeliver forever
      // and block every later message on the partition -- one dead site would
      // stop the whole pipeline.
      return true;
    }
  }

  /**
   * The subscribed handler. Declines new work once shutdown has begun: the link
   * is still `pending` at this point, so the reaper simply publishes it again
   * on the next process's first sweep. Nothing is lost by not starting.
   */
  async function handle(payload) {
    if (drain.draining) return false;
    return drain.track(() => runOne(payload));
  }

  return {
    handle,

    async start() {
      await bus.subscribe({
        topic: TOPICS.LINK_CREATED,
        groupId: 'metadata-worker',
        handler: handle,
      });
    },

    /** Waits for the page currently being fetched, rather than dropping it. */
    async stop() {
      await drain.drain();
    },
  };
}
