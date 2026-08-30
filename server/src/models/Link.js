import mongoose from 'mongoose';

/**
 * `queued` sits between `pending` and `processing` and exists for one reason:
 * without it the reaper republishes every waiting link on every sweep. It also
 * marks the window where a message is in flight and the database cannot yet
 * know whether a consumer received it -- which is what the stale-`queued` sweep
 * in workers/linkQueue.js recovers from.
 */
export const PROCESSING_STATUSES = ['pending', 'queued', 'processing', 'ready', 'failed'];

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

    // Filled in by later phases. Nothing writes these yet.
    summary: { type: String, trim: true, maxlength: 2000, default: '' },
    // Vector payloads are large and never needed by a list view.
    embedding: { type: [Number], default: undefined, select: false },

    tags: {
      type: [{ type: String, trim: true, maxlength: 40 }],
      default: [],
    },
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
    collectionId: this.collectionId ? this.collectionId.toString() : null,
    isFavorite: this.isFavorite,
    isRead: this.isRead,
    processingStatus: this.processingStatus,
    // Only meaningful while `processingStatus` is 'failed'; the row shows it
    // beside the retry action.
    processingError: this.processingError,
    processedAt: this.processedAt,
    savedAt: this.savedAt,
    updatedAt: this.updatedAt,
  };
};

export const Link = mongoose.model('Link', linkSchema);
