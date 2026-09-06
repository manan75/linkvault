import { Link } from '../models/Link.js';
import { buildSearchTokens } from './searchTokens.js';

/** How many links to rebuild per round trip. */
const BATCH_SIZE = 500;

/**
 * Rebuilds `searchTokens` for every link matching a filter.
 *
 * Two callers, and they want the same thing for different reasons:
 *
 * - `renameTag`, which rewrites tag arrays with an aggregation pipeline. That
 *   never loads a document, so the `pre('save')` hook cannot fire and the
 *   tokens would otherwise still describe the old tag.
 * - the backfill in `scripts/reindexSearch.js`, for links saved before this
 *   field existed, which have no tokens at all and would be unfindable.
 *
 * Writes with `bulkWrite` rather than `save()` because there is nothing to
 * validate: the tokens are derived from fields already on the document, and
 * running full document validation over a whole library to write one derived
 * array is a great deal of work to reach the same bytes.
 */
export async function reindexKeywords(filter, { batchSize = BATCH_SIZE } = {}) {
  let updated = 0;
  let lastId = null;

  for (;;) {
    // Paged by `_id` rather than by `skip`, so a concurrent write cannot make
    // the pager step over a link it has not visited yet.
    const page = await Link.find(lastId ? { ...filter, _id: { $gt: lastId } } : filter)
      .select('+searchTokens')
      .sort({ _id: 1 })
      .limit(batchSize);

    if (page.length === 0) break;

    const writes = page.map((link) => ({
      updateOne: {
        filter: { _id: link._id },
        update: { $set: { searchTokens: buildSearchTokens(link) } },
      },
    }));

    const result = await Link.bulkWrite(writes, { ordered: false });
    updated += result.modifiedCount ?? 0;
    lastId = page.at(-1)._id;

    if (page.length < batchSize) break;
  }

  return { updated };
}
