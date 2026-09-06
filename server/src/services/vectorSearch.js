import { Link } from '../models/Link.js';

/**
 * Nearest-neighbour search over stored embeddings.
 *
 * A brute-force cosine scan in Node, and the seam behind which that can be
 * replaced. Per the Important Rule in `CLAUDE.md`, the case for *not* reaching
 * for Atlas Vector Search yet:
 *
 * **What it would solve.** Nothing that is a problem at this size.
 * `MAX_LINKS_PER_USER` is 100, and a scan is anchored to one owner. Even at a
 * hundred times that, ten thousand vectors at 512 dimensions is a few million
 * multiply-adds -- single-digit milliseconds, and the round trip to Atlas costs
 * more than the arithmetic does.
 *
 * **What it would cost.** `$vectorSearch` is an Atlas-only aggregation stage.
 * It does not exist in `mongodb-memory-server` or in the Mongo image
 * `docker-compose.yml` runs, so adopting it means the 290-test suite can no
 * longer test search, and local development cannot run it at all. That is a
 * steep price for latency nobody has measured a problem with.
 *
 * **What changes the answer.** Memory, not time. This reads every candidate
 * vector into the process, so cost scales with the corpus per search. Ten
 * thousand links at 512 dimensions is roughly 40MB per query on a 512MB
 * instance, and that is the point at which an index earns its keep.
 *
 * Until then the honest thing is the simple thing, kept behind one function so
 * that swapping it is a change to this file.
 */

/** A hard ceiling on vectors read into memory for one search. */
export const MAX_VECTORS_SCANNED = 2_000;

/**
 * Cosine similarity, in [-1, 1].
 *
 * Written out rather than normalising first: the provider returns unit-length
 * vectors, so dividing by the magnitudes is arithmetically redundant -- but
 * only while that stays true, and a silently wrong similarity is a search that
 * merely looks disappointing rather than one that visibly breaks.
 */
export function cosineSimilarity(a, b) {
  if (!a?.length || a.length !== b?.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * The links closest to a query vector, most similar first.
 *
 * `filter` is the structural filter from `buildLinkQuery`, applied in the
 * database rather than after ranking. That ordering matters for correctness as
 * well as cost: filtering afterwards would let a collection of ten links return
 * three, because the seven best matches overall belonged to a different one.
 *
 * Returns ids and scores rather than documents. The caller is fusing two
 * ranked lists and only needs the documents for the page it finally shows.
 */
export async function nearestLinks({
  filter,
  vector,
  limit = 50,
  maxScanned = MAX_VECTORS_SCANNED,
}) {
  if (!vector?.length) return [];

  const candidates = await Link.find({ ...filter, embedding: { $exists: true, $ne: [] } })
    .select('_id embedding')
    .limit(maxScanned)
    .lean();

  return candidates
    .map((candidate) => ({
      id: candidate._id.toString(),
      score: cosineSimilarity(vector, candidate.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
