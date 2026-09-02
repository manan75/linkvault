import { isObjectId } from '../utils/objectId.js';

/** Filter value meaning "links that are not in any collection". */
export const UNCATEGORISED = 'none';

export const LINK_SORTS = ['newest', 'oldest', 'relevance'];

const SORT_ORDERS = {
  newest: { savedAt: -1, _id: -1 },
  oldest: { savedAt: 1, _id: 1 },
};

/**
 * Translates validated list parameters into a Mongo filter, sort and paging.
 *
 * Kept out of the route handler because the Phase 8 hybrid search needs the same
 * filters applied to a differently-ranked result set, and because the `userId`
 * scope belongs somewhere it cannot be forgotten.
 */
export function buildLinkQuery(userId, params = {}) {
  const { q, tag, collectionId, domain, isFavorite, isRead, savedAfter, savedBefore } = params;

  // Every filter is anchored to the owner. A link query without this serves
  // another user's private bookmarks.
  const filter = { userId };

  if (q) filter.$text = { $search: q };

  // Multiple tags narrow the result: a link must carry all of them.
  if (tag?.length) filter.tags = { $all: tag };

  if (collectionId === UNCATEGORISED) {
    filter.collectionId = null;
  } else if (isObjectId(collectionId)) {
    filter.collectionId = collectionId;
  }

  if (domain) filter.domain = domain.toLowerCase().replace(/^www\./, '');
  if (typeof isFavorite === 'boolean') filter.isFavorite = isFavorite;
  if (typeof isRead === 'boolean') filter.isRead = isRead;

  if (savedAfter || savedBefore) {
    filter.savedAt = {
      ...(savedAfter ? { $gte: savedAfter } : {}),
      ...(savedBefore ? { $lte: savedBefore } : {}),
    };
  }

  // Relevance only exists when there is a search term to be relevant to.
  const wantsRelevance = params.sort === 'relevance' || (!params.sort && Boolean(q));
  const useRelevance = wantsRelevance && Boolean(q);

  return {
    filter,
    sort: useRelevance
      ? { score: { $meta: 'textScore' }, savedAt: -1 }
      : SORT_ORDERS[params.sort] ?? SORT_ORDERS.newest,
    projection: useRelevance ? { score: { $meta: 'textScore' } } : undefined,
    skip: ((params.page ?? 1) - 1) * (params.limit ?? 20),
    limit: params.limit ?? 20,
  };
}
