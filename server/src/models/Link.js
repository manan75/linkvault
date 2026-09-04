import mongoose from 'mongoose';

/**
 * `queued` sits between `pending` and `processing` and exists for one reason:
 * without it the reaper republishes every waiting link on every sweep. It also
 * marks the window where a message is in flight and the database cannot yet
 * know whether a consumer received it -- which is what the stale-`queued` sweep
 * in workers/linkQueue.js recovers from.
 */
export const PROCESSING_STATUSES = ['pending', 'queued', 'processing', 'ready', 'failed'];

/**
 * Enrichment runs its own state machine, deliberately separate from
 * `processingStatus`. A link whose enrichment failed is still a perfectly good
 * bookmark -- it has a title, a favicon and a URL, and it opens -- so it must
 * not be shown to the user as broken.
 *
 * `skipped` is a real terminal state rather than a failure: no API key
 * configured, or nothing worth sending (see services/enrichment.js).
 */
export const ENRICHMENT_STATUSES = [
  'pending',
  'queued',
  'processing',
  'done',
  'skipped',
  'failed',
];

const linkSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Exactly what the user saved, so the bookmark always opens the page they meant.
    url: { type: String, required: true, trim: true },
    // Normalised form that uniqueness compares. See utils/canonicalUrl.js.
    canonicalUrl: { type: String, required: true, trim: true },

    title: { type: String, trim: true, maxlength: 300, default: '' },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    domain: { type: String, trim: true, required: true },

    // CLAUDE.md asks for "extract author when available" under URL Processing
    // but lists no field to put it in. Added here to close that gap.
    author: { type: String, trim: true, maxlength: 200, default: '' },

    // Written by the metadata worker. Both end up in an <img src>, so
    // extraction only ever stores http(s) URLs -- see utils/sanitize.js.
    favicon: { type: String, trim: true, default: '' },
    thumbnail: { type: String, trim: true, default: '' },

    // Written by the enrichment worker. One or two sentences; the 2000 limit is
    // a ceiling, not a goal. Empty when the page gave the model nothing to work
    // with -- an invented summary is worse than none, because it is shown as
    // fact and Phase 6 will embed it.
    summary: { type: String, trim: true, maxlength: 2000, default: '' },
    // Filled in by Phase 6. Nothing writes this yet.
    // Vector payloads are large and never needed by a list view.
    embedding: { type: [Number], default: undefined, select: false },

    /**
     * What the browser extension saw, for pages the server cannot reach.
     *
     * `safeFetch` calls from a datacenter, and production showed what that
     * costs: YouTube answers 429 and LeetCode 403 to this server specifically,
     * whatever it sends. The extension holds the rendered DOM of the page the
     * user is already looking at, from their own address and their own session,
     * so paywalls, login walls and JavaScript-rendered apps stop applying.
     *
     * It is still fetched webpage content and is sanitised exactly as
     * `parseMetadata`'s output is. Arriving with a valid credential attached
     * makes it feel trusted; it is not (`CLAUDE.md` §7).
     *
     * `select: false` because it is only ever read by the metadata worker and
     * would otherwise ride along on every dashboard listing. `text` is kept
     * after use rather than discarded: it is the input Phase 6 embeds, and
     * keeping it means re-embedding the corpus later does not mean asking every
     * user to revisit every page.
     */
    capture: {
      type: {
        title: { type: String, trim: true, maxlength: 300, default: '' },
        description: { type: String, trim: true, maxlength: 2000, default: '' },
        author: { type: String, trim: true, maxlength: 200, default: '' },
        favicon: { type: String, trim: true, default: '' },
        thumbnail: { type: String, trim: true, default: '' },
        text: { type: String, default: '' },
        capturedAt: { type: Date, default: null },
      },
      default: undefined,
      select: false,
    },

    // The effective tag set: what the user filters and searches by, whatever
    // its provenance. Type unchanged from Phase 2, so every index, the text
    // index and the `$all` filters keep working with no migration.
    tags: {
      type: [{ type: String, trim: true, maxlength: 40 }],
      default: [],
    },
    // Exactly what the model produced, kept apart from the effective set so the
    // two can be told apart in the UI and by any future backfill.
    autoTags: {
      type: [{ type: String, trim: true, maxlength: 40 }],
      default: [],
    },
    // Once the user has curated this link's tags, enrichment stops touching
    // them. Without this, deleting an auto-tag you dislike only lasts until the
    // next re-enrichment puts it back, which is the fastest way to make someone
    // turn the feature off.
    tagsEditedByUser: { type: Boolean, default: false },
    collectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Collection',
      default: null,
    },

    isFavorite: { type: Boolean, default: false },
    isRead: { type: Boolean, default: false },

    processingStatus: {
      type: String,
      enum: PROCESSING_STATUSES,
      default: 'pending',
    },
    // How many times extraction has been tried, so the retry policy has
    // somewhere to count and knows when to give up.
    processingAttempts: { type: Number, default: 0 },
    // A short reason safe to show the user next to the retry action.
    processingError: { type: String, trim: true, maxlength: 300, default: '' },
    // When the link was published to the event log. A `queued` link older than
    // its lease means the message never reached a consumer -- broker down, or
    // the process died between the status write and the publish.
    queuedAt: { type: Date, default: null },
    // When the current claim was taken. A claim older than the lease is
    // assumed to belong to a process that died and is handed back.
    processingStartedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },

    // --- Enrichment (Phase 5) ---
    // The same lease and retry bookkeeping the extraction fields carry above,
    // for the same reasons: a redelivered event must not bill a second API
    // call, and a consumer that dies mid-call must not strand the link.
    enrichmentStatus: {
      type: String,
      enum: ENRICHMENT_STATUSES,
      default: 'pending',
    },
    enrichmentAttempts: { type: Number, default: 0 },
    enrichmentError: { type: String, trim: true, maxlength: 300, default: '' },
    enrichmentQueuedAt: { type: Date, default: null },
    enrichmentStartedAt: { type: Date, default: null },
    enrichedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'savedAt', updatedAt: 'updatedAt' } },
);

// One bookmark per URL per user. This is also the idempotency key the Phase 4
// workers will rely on when Kafka redelivers a `link.created` event.
linkSchema.index({ userId: 1, canonicalUrl: 1 }, { unique: true });

// Serves the default dashboard listing: a user's links, newest first.
linkSchema.index({ userId: 1, savedAt: -1 });
linkSchema.index({ userId: 1, tags: 1 });
linkSchema.index({ userId: 1, collectionId: 1 });

// Serves the reaper's claim query: the oldest link waiting to be published.
// Deliberately not scoped by user -- the reaper sweeps every user's queue.
linkSchema.index({ processingStatus: 1, savedAt: 1 });

// Serves the enrichment half of the same sweep, which only ever looks at links
// extraction has already finished with.
linkSchema.index({ enrichmentStatus: 1, processingStatus: 1, savedAt: 1 });

// Keyword search. Weighted so a match in the title outranks one in the body of a
// description. This is the keyword half of the Phase 8 hybrid search.
linkSchema.index(
  { title: 'text', tags: 'text', description: 'text', summary: 'text', url: 'text' },
  {
    name: 'link_keyword_search',
    weights: { title: 10, tags: 8, summary: 4, description: 2, url: 1 },
  },
);

linkSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    url: this.url,
    canonicalUrl: this.canonicalUrl,
    title: this.title,
    description: this.description,
    summary: this.summary,
    domain: this.domain,
    author: this.author,
    favicon: this.favicon,
    thumbnail: this.thumbnail,
    tags: this.tags,
    // The client greys these out so a generated tag is visibly not a typed one.
    autoTags: this.autoTags,
    tagsEditedByUser: this.tagsEditedByUser,
    collectionId: this.collectionId ? this.collectionId.toString() : null,
    isFavorite: this.isFavorite,
    isRead: this.isRead,
    processingStatus: this.processingStatus,
    // Only meaningful while `processingStatus` is 'failed'; the row shows it
    // beside the retry action.
    processingError: this.processingError,
    processedAt: this.processedAt,
    // Deliberately exposed without an error string: §8 of the Phase 5 plan.
    // A failed enrichment is not something to show the user as a broken link,
    // so the client only ever uses this to decide whether to show a "writing a
    // summary" hint.
    enrichmentStatus: this.enrichmentStatus,
    enrichedAt: this.enrichedAt,
    savedAt: this.savedAt,
    updatedAt: this.updatedAt,
  };
};

export const Link = mongoose.model('Link', linkSchema);
