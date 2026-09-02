import mongoose from 'mongoose';

import { Collection } from '../models/Collection.js';
import { Link } from '../models/Link.js';
import { ApiError } from '../utils/ApiError.js';
import { isObjectId } from '../utils/objectId.js';

const DUPLICATE_NAME = 'You already have a collection with that name';

/** Case-insensitive lookup, matching the collation on the uniqueness index. */
function findByName(userId, name) {
  return Collection.findOne({ userId, name }).collation({ locale: 'en', strength: 2 });
}

export async function createCollection({ userId, name }) {
  if (await findByName(userId, name)) throw ApiError.conflict(DUPLICATE_NAME);

  try {
    return await Collection.create({ userId, name });
  } catch (error) {
    // The unique index is the real guard against a race with the check above.
    if (error?.code === 11000) throw ApiError.conflict(DUPLICATE_NAME);
    throw error;
  }
}

/**
 * A user's collections with the number of links in each, plus the count of
 * links in none of them, which the dashboard shows as its own sidebar entry.
 */
export async function listCollections(userId) {
  const [collections, counts] = await Promise.all([
    Collection.find({ userId }).collation({ locale: 'en', strength: 2 }).sort({ name: 1 }),
    Link.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      { $group: { _id: '$collectionId', count: { $sum: 1 } } },
    ]),
  ]);

  const countByCollection = new Map(
    counts.map(({ _id, count }) => [_id ? _id.toString() : null, count]),
  );

  return {
    collections: collections.map((collection) => ({
      ...collection.toPublicJSON(),
      linkCount: countByCollection.get(collection._id.toString()) ?? 0,
    })),
    uncategorisedCount: countByCollection.get(null) ?? 0,
    totalCount: counts.reduce((total, { count }) => total + count, 0),
  };
}

/**
 * Loads a collection the user owns, or throws 404. Scoping by `userId` rather
 * than by id alone is what keeps one user's collections invisible to another --
 * and 404 rather than 403 avoids confirming that the id exists at all.
 */
export async function getOwnedCollection({ userId, id }) {
  if (!isObjectId(id)) throw ApiError.notFound('Collection not found');

  const collection = await Collection.findOne({ _id: id, userId });
  if (!collection) throw ApiError.notFound('Collection not found');

  return collection;
}

export async function renameCollection({ userId, id, name }) {
  const collection = await getOwnedCollection({ userId, id });

  const clash = await findByName(userId, name);
  if (clash && !clash._id.equals(collection._id)) throw ApiError.conflict(DUPLICATE_NAME);

  collection.name = name;

  try {
    return await collection.save();
  } catch (error) {
    if (error?.code === 11000) throw ApiError.conflict(DUPLICATE_NAME);
    throw error;
  }
}

/**
 * Deletes a collection and releases its links rather than destroying them --
 * deleting a folder should not silently delete bookmarks the user still wants.
 *
 * The links are released first on purpose: a failure after this point leaves an
 * empty collection, which is harmless, whereas the other order would leave links
 * pointing at a collection that no longer exists.
 */
export async function deleteCollection({ userId, id }) {
  const collection = await getOwnedCollection({ userId, id });

  const { modifiedCount } = await Link.updateMany(
    { userId, collectionId: collection._id },
    { $set: { collectionId: null } },
  );

  await collection.deleteOne();

  return { releasedLinks: modifiedCount };
}
