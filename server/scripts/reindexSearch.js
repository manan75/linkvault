import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { Link } from '../src/models/Link.js';
import { reindexKeywords } from '../src/services/searchIndex.js';

/**
 * The one-time migration from `$text` search to prefix search.
 *
 * Run once against each deployment, after the new code is live:
 *
 * ```
 * MONGODB_URI='mongodb+srv://...' node scripts/reindexSearch.js
 * ```
 *
 * It is a script rather than something the server does at boot for two reasons.
 * It rewrites every link in the database, which is not a thing that should
 * happen silently on a restart or race a second instance rolling out. And it
 * drops an index, which is a deliberate act.
 *
 * Safe to run more than once. Both halves converge on the same state: the
 * backfill recomputes tokens that are already correct, and dropping an index
 * that is already gone is reported and skipped.
 */

/** The `$text` index the prefix index replaces. Named, so nothing else is hit. */
const OBSOLETE_TEXT_INDEX = 'link_keyword_search';

/**
 * Removes the old text index.
 *
 * Worth doing rather than leaving in place. It is now dead weight on every
 * write to the collection, it is the largest index on it, and MongoDB permits
 * only one text index per collection -- so leaving it there is also what would
 * block any future decision to use `$text` for something it is actually good at.
 */
async function dropObsoleteIndex() {
  const indexes = await Link.collection.indexes();
  const existing = indexes.find((index) => index.name === OBSOLETE_TEXT_INDEX);

  if (!existing) {
    console.log(`- ${OBSOLETE_TEXT_INDEX}: already gone`);
    return false;
  }

  await Link.collection.dropIndex(OBSOLETE_TEXT_INDEX);
  console.log(`- ${OBSOLETE_TEXT_INDEX}: dropped`);
  return true;
}

async function run() {
  await connectDatabase();
  console.log(`Connected to ${mongoose.connection.name}`);

  // Ahead of the backfill, so the tokens are written into an index that exists
  // rather than triggering a build over a collection that has just been
  // rewritten. `Link.init()` waits for it, which `autoIndex` alone does not.
  await Link.init();
  console.log('- link_keyword_prefix: ready');

  await dropObsoleteIndex();

  const total = await Link.estimatedDocumentCount();
  console.log(`Reindexing ${total} link(s)...`);

  const { updated } = await reindexKeywords({});

  // `updated` counts documents whose tokens actually changed, so a second run
  // reporting zero is the migration confirming it has nothing left to do.
  console.log(`Done. ${updated} link(s) rewritten.`);

  await disconnectDatabase();
}

run().catch(async (error) => {
  console.error('Reindex failed:', error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
