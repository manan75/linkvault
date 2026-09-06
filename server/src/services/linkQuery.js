import { isObjectId } from '../utils/objectId.js';
import { prefixClause, queryTerms } from './searchTokens.js';

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
 * Kept out of the route handler because the hybrid search needs the same
 * filters applied to a differently-ranked result set, and because the `userId`
 * scope belongs somewhere it cannot be forgotten.
 *
 * `q` is deliberately *not* part of this filter. Everything here is a
 * structural narrowing -- owner, tag, collection, flags, dates -- and it is
 * exactly the set of conditions that must hold however the results are ranked.
 * The search term is a ranking input as much as a filter, and it is applied on
 * top of this by `services/search.js`.
 */
export function buildLinkQuery(userId, params = {}) {
  const { tag, collectionId, domain, isFavorite, isRead, savedAfter, savedBefore } = params;

  // Every filter is anchored to the owner. A link query without this serves
  // another user's private bookmarks.
  const filter = { userId };

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

  return {
    filter,
    sort: SORT_ORDERS[params.sort] ?? SORT_ORDERS.newest,
    skip: ((params.page ?? 1) - 1) * (params.limit ?? 20),
    limit: params.limit ?? 20,
  };
}

/**
 * Narrows a structural filter to links matching a typed query.
 *
 * `mode` is the difference between the two things a search box has to do:
 *
 * - `all` requires every term, which is what typing more words means. This is
 *   the behaviour `$text` could not provide -- it ORs its terms, so every extra
 *   word made the result set *bigger*, which is precisely the "search does not
 *   filter" complaint.
 * - `any` requires one, and exists only as the fallback below: a sentence typed
 *   into the box ("how do I make my backend faster") shares no single document
 *   with every one of its words, and returning nothing at all is a worse answer
 *   than returning the closest few.
 *
 * Each term is an anchored prefix, so results narrow with every keystroke
 * instead of appearing only when a whole word lands.
 */
export function withKeyword(filter, terms, mode = 'all') {
  if (!terms.length) return filter;

  const clauses = terms.map(prefixClause);

  return mode === 'all' ? { ...filter, $and: clauses } : { ...filter, $or: clauses };
}

export { queryTerms };
