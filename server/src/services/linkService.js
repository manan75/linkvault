import mongoose from 'mongoose';

import { Link } from '../models/Link.js';
import { canonicalizeUrl } from '../utils/canonicalUrl.js';
import { ApiError } from '../utils/ApiError.js';
import { isObjectId } from '../utils/objectId.js';
import { buildLinkQuery } from './linkQuery.js';
import { getOwnedCollection } from './collectionService.js';

/** Fields a user may set by hand. Everything else belongs to the pipeline. */
const EDITABLE_FIELDS = ['title', 'description', 'tags', 'collectionId', 'isFavorite', 'isRead'];

/**
 * Saves a URL, or returns the bookmark the user already has for it.
 *
 * Re-saving is not an error: the product exists for people who do not remember
 * what they saved, so being told off for saving something twice is the wrong
 * answer. `created` tells the caller which happened, for the status code.
 *
 * `collectionId` is optional. Omitting it means "wherever it already is" rather
 * than "nowhere": it is the default the save form submits, so treating it as an
 * instruction would let a routine re-save quietly unfile an existing bookmark.
 * Only an explicit collection moves anything.
 */
export async function createLink({ userId, url, collectionId }) {
  const { url: originalUrl, canonicalUrl, domain } = canonicalizeUrl(url);

  if (collectionId) await getOwnedCollection({ userId, id: collectionId });

  const existing = await Link.findOne({ userId, canonicalUrl });

  if (existing) {
    // The user picked a collection for a URL they had already saved. Honouring
    // that beats reporting "already saved" and silently dropping the choice.
    const moved = Boolean(collectionId) && String(existing.collectionId) !== String(collectionId);

    if (moved) {
      existing.collectionId = collectionId;
      await existing.save();
    }

    return { link: existing, created: false, moved };
  }

  try {
    const link = await Link.create({
      userId,
      url: originalUrl,
      canonicalUrl,
      domain,
      collectionId: collectionId ?? null,
    });
    return { link, created: true, moved: false };
  } catch (error) {
    // Two concurrent saves of the same URL: the index caught the loser, so
    // return what the winner created.
    if (error?.code === 11000) {
      const link = await Link.findOne({ userId, canonicalUrl });
      if (link) return { link, created: false, moved: false };
    }
    throw error;
  }
}

export async function listLinks({ userId, params }) {
  const { filter, sort, projection, skip, limit } = buildLinkQuery(userId, params);

  const [links, total] = await Promise.all([
    Link.find(filter, projection).sort(sort).skip(skip).limit(limit),
    Link.countDocuments(filter),
  ]);

  return {
    links: links.map((link) => link.toPublicJSON()),
    page: params.page ?? 1,
    limit,
    total,
    hasMore: skip + links.length < total,
  };
}

/**
 * Loads a link the user owns, or throws 404.
 *
 * The `userId` in the filter is the whole privacy guarantee: looking a link up
 * by id alone would happily serve, edit or destroy another user's bookmark.
 * A missing link and someone else's link are deliberately indistinguishable.
 */
export async function getOwnedLink({ userId, id }) {
  if (!isObjectId(id)) throw ApiError.notFound('Link not found');

  const link = await Link.findOne({ _id: id, userId });
  if (!link) throw ApiError.notFound('Link not found');

  return link;
}

export async function updateLink({ userId, id, patch }) {
  const link = await getOwnedLink({ userId, id });

  // Assigning to a collection someone else owns would leak its existence, so the
  // ownership check runs before the write.
  if (patch.collectionId) {
    await getOwnedCollection({ userId, id: patch.collectionId });
  }

  for (const field of EDITABLE_FIELDS) {
    if (patch[field] !== undefined) link[field] = patch[field];
  }

  return link.save();
}

/**
 * Puts a link back in the queue after extraction failed.
 *
 * The attempt count resets because this is a fresh decision by the user, not a
 * continuation of the automatic retries -- a site that was down yesterday may
 * be up now, and the ladder has already been exhausted.
 */
export async function retryProcessing({ userId, id }) {
  const link = await getOwnedLink({ userId, id });

  // Claiming works by moving a link out of `pending`; resetting one that is
  // mid-flight would let a second worker claim it alongside the first.
  if (link.processingStatus === 'processing') {
    throw ApiError.conflict('That link is being processed right now');
  }

  link.processingStatus = 'pending';
  link.processingAttempts = 0;
  link.processingError = '';
  link.processingStartedAt = null;
  link.queuedAt = null;

  return link.save();
}

export async function deleteLink({ userId, id }) {
  const link = await getOwnedLink({ userId, id });
  await link.deleteOne();
}

/** Every tag the user has used, with counts, for the dashboard's tag filter. */
export async function listTags(userId) {
  const tags = await Link.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    { $unwind: '$tags' },
    { $group: { _id: '$tags', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
  ]);

  return tags.map(({ _id, count }) => ({ name: _id, count }));
}
