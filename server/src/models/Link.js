import mongoose from 'mongoose';

import { buildSearchTokens } from '../services/searchTokens.js';

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

/**
 * Embedding runs a third state machine, separate again and for the same reason.
 *
 * A link that could not be embedded is still a perfectly good bookmark and is
 * still findable by keyword -- it is only absent from semantic results. So this
 * never marks a link broken either, and nothing in the UI reports it as an
 * error.
 *
 * Unlike the other two, this machine returns to `pending` during ordinary life:
 * editing a title or writing a summary changes what the link means, so the
 * vector describing it is out of date. There is no separate `stale` state
 * because there is nothing different to do about it -- the link stays fully
 * searchable by its existing vector until the new one lands, and the sweep that
 * picks up `pending` work is already the right sweep.
 */
export const EMBEDDING_STATUSES = ['pending', 'queued', 'processing', 'done', 'skipped', 'failed'];

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
    // Vector payloads are large and never needed by a list view.
    embedding: { type: [Number], default: undefined, select: false },

    /**
     * Every word this bookmark can be found by, materialised so the keyword
     * search can match a prefix and require every term.
     *
     * Derived, never authored: the `pre('save')` hook below rebuilds it from
     * the fields in `searchableFields()` whenever one of them changes, so it
     * cannot drift from the document it describes. See `services/searchTokens.js`
     * for what MongoDB's `$text` index could not do and why this exists.
     *
     * `select: false` for the same reason `embedding` is: it is a query-time
     * index, not something any response body needs.
     */
    searchTokens: { type: [String], default: [], select: false },

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

    // --- Embedding (Phase 6) ---
    // The third copy of the same lease and retry bookkeeping, for the third
    // time for the same reason: a redelivered event must not bill a second
    // call, and a consumer that dies mid-call must not strand the link.
    embeddingStatus: {
      type: String,
      enum: EMBEDDING_STATUSES,
      default: 'pending',
    },
    embeddingAttempts: { type: Number, default: 0 },
    embeddingError: { type: String, trim: true, maxlength: 300, default: '' },
    embeddingQueuedAt: { type: Date, default: null },
    embeddingStartedAt: { type: Date, default: null },
    embeddedAt: { type: Date, default: null },
    /**
     * A fingerprint of the text the stored vector was built from, and of the
     * model that built it.
     *
     * Two jobs. It stops a redelivered event paying for a vector identical to
     * the one already stored -- enrichment writing the same summary twice is
     * routine, and the claim alone cannot tell that apart from a real change.
     * And because the model name is part of it, changing `EMBEDDING_MODEL` or
     * `EMBEDDING_DIMENSIONS` invalidates the whole corpus automatically:
     * vectors from two models are points in unrelated spaces and comparing them
     * is meaningless, so that has to be noticed rather than migrated.
     */
    embeddingFingerprint: { type: String, default: '' },
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

// And the embedding half. Not scoped by `processingStatus` like the one above:
// a link whose extraction failed still has whatever the user typed and whatever
// the extension captured, and that is often enough to embed.
linkSchema.index({ embeddingStatus: 1, savedAt: 1 });

/**
 * Keyword search, and the keyword half of the hybrid search.
 *
 * Two things about this index are deliberate and were both wrong before.
 *
 * **It is prefixed by `userId`.** The `$text` index this replaced was not, so
 * Mongo could not scope the scan to the owner: it read every matching link
 * belonging to *every* user and threw the rest away afterwards. Explained on a
 * corpus of 20 of my links among 2,000 of someone else's, one search returned
 * 20 documents and examined 4,040 -- and `listLinks` runs `countDocuments` on
 * the same filter, so it paid that twice per request. This index cannot be
 * used without an equality match on `userId`, which every query here has.
 *
 * **It is a multikey index on an ordinary array, not a text index.** That is
 * what makes `^reac` an index seek rather than a collection scan, and what lets
 * a query AND several terms together -- one clause each, all of them using this
 * index. A text index can do neither.
 *
 * Named differently from the `link_keyword_search` text index it replaces, and
 * that is not cosmetic. Reusing the name would make every existing deployment
 * fail to start: an index name is unique per collection, `autoIndex` creates
 * missing indexes but never drops a conflicting one, and Mongo answers a
 * same-name-different-keys request with `IndexOptionsConflict`. Under a new
 * name this index simply builds on deploy, and `scripts/reindexSearch.js`
 * removes the old one.
 */
linkSchema.index({ userId: 1, searchTokens: 1 }, { name: 'link_keyword_prefix' });

/**
 * Keeps the derived token set honest.
 *
 * Every hand edit and every pipeline write goes through `save()` -- the two
 * queues, `updateLink`, and enrichment all do -- so this one hook covers them.
 * The exception is `renameTag`, which rewrites arrays with an aggregation
 * pipeline for a good reason and re-indexes explicitly afterwards.
 */
linkSchema.pre('save', function rebuildSearchTokens(next) {
  const touched = ['title', 'description', 'summary', 'tags', 'author', 'domain', 'url'];

  if (!this.isNew && !touched.some((path) => this.isModified(path))) return next();

  this.searchTokens = buildSearchTokens(this);

  /**
   * The same change that invalidates the token set invalidates the vector.
   *
   * Without this, a link embedded from a bare title before enrichment ran would
   * keep that vector forever and never learn the summary written for it -- and
   * the summary is the single most useful thing in the embedding input. A user
   * correcting a title would likewise be searching by meaning against the old
   * one indefinitely.
   *
   * `queued` and `processing` are deliberately left alone: a message is in
   * flight or a call is open against them, and resetting a claim out from under
   * a worker is how two consumers end up writing the same document. The worker
   * finishes, sets `done`, and the fingerprint mismatch brings it back here on
   * the next edit. Links already `pending` are simply already correct.
   */
  if (!this.isNew && ['done', 'skipped', 'failed'].includes(this.embeddingStatus)) {
    this.embeddingStatus = 'pending';
    this.embeddingAttempts = 0;
    this.embeddingError = '';
    this.embeddingQueuedAt = null;
  }

  next();
});

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
    // Exposed on the same terms and for the same reason: a link that has not
    // been embedded is not broken, it is merely absent from semantic results
    // until it is. The client uses this only to say a link is still being
    // indexed, never to mark it as failed.
    embeddingStatus: this.embeddingStatus,
    embeddedAt: this.embeddedAt,
    savedAt: this.savedAt,
    updatedAt: this.updatedAt,
  };
};

export const Link = mongoose.model('Link', linkSchema);
