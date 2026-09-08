import { env } from '../config/env.js';
import { Link } from '../models/Link.js';
import { embedQuery as callProvider } from './embedding.js';
import { buildLinkQuery, queryTerms, withKeyword } from './linkQuery.js';
import { matchPrefix, tokenize } from './searchTokens.js';
import { nearestLinks } from './vectorSearch.js';

/**
 * Ranked search over one user's bookmarks, by words and by meaning.
 *
 * The two halves answer different questions and neither subsumes the other,
 * which is why `CLAUDE.md` says not to assume semantic search is always
 * superior. Measured on a corpus containing exactly the right document:
 *
 * - Keyword alone cannot answer "make my backend snappier" -> "Redis Caching
 *   Strategies". There is no shared word to match. That is the product thesis
 *   and it needs embeddings.
 * - Semantic alone is poor at the thing people do most, which is typing the
 *   first few letters of a title they half remember. A vector for "reac" is not
 *   near a vector for "React Server Components"; it is not near anything.
 *
 * So both run, and the results are fused. Ranking happens here, in Node, rather
 * than in the database: `MAX_LINKS_PER_USER` is 100, the filter is anchored to
 * one owner, and one scoring pass that both halves feed is far easier to reason
 * about than a database ordering a second pass then has to disturb.
 *
 * The bound is `CANDIDATE_LIMIT`, and it is the thing to watch: past it,
 * ranking is over a truncated set.
 */

/** How many matching links may be ranked. Well above `MAX_LINKS_PER_USER`. */
export const CANDIDATE_LIMIT = 500;

/** How many semantic neighbours to consider for fusion. */
const SEMANTIC_LIMIT = 50;

/**
 * How similar a link must be to a query to count as a semantic match at all.
 *
 * Without a floor, semantic search has no notion of "no results": every vector
 * has *some* cosine similarity to every other, so a query for nonsense would
 * return the whole vault in a confident-looking order. The floor is what makes
 * an empty result possible, and an honest empty result is worth a great deal
 * more than a plausible wrong one.
 *
 * The value is a starting point, not a measurement -- it is roughly where
 * `text-embedding-3-small` puts unrelated short texts -- and it is the first
 * thing to tune once there is a real vault to tune against. Too low shows
 * strangers; too high loses the paraphrase this feature exists for.
 */
const MIN_SIMILARITY = 0.3;

/**
 * Reciprocal-rank fusion, and the constant that damps it.
 *
 * The two halves produce scores that are not comparable in any units -- a
 * keyword score is a weighted term count, a semantic score is a cosine -- so
 * they are combined by *rank* rather than by value, which needs no calibration
 * and cannot be skewed by one half having a wider range than the other.
 *
 * 60 is the value from the paper RRF comes from, and it does the work: it keeps
 * the gap between rank 1 and rank 2 from dominating, so a link both halves like
 * moderately can outrank one that only a single half loves.
 */
const RRF_K = 60;

/**
 * How much each half is worth.
 *
 * Keyword leads because most searches are someone typing part of a title, and
 * being wrong about those is far more annoying than being wrong about a
 * paraphrase. Semantic is what makes the vault answerable at all when the
 * remembered words are not the written ones.
 */
const KEYWORD_WEIGHT = 1;
const SEMANTIC_WEIGHT = 0.8;

/**
 * What a keyword match is worth, by where it was found.
 *
 * Carried over from the weights on the text index this replaced, so ranking
 * behaviour did not silently change along with matching behaviour: a title
 * match outranks a body match, and a URL match barely counts.
 */
const FIELD_WEIGHTS = {
  title: 10,
  tags: 8,
  summary: 4,
  description: 2,
  author: 2,
  domain: 1.5,
  url: 1,
};

/**
 * A whole-token match is worth more than a prefix of one.
 *
 * Without this, typing "cache" would rank "cache-control" exactly as highly as
 * "cache", and the list would visibly reshuffle as the user finished a word
 * they had already effectively typed.
 */
const EXACT_MATCH = 1;
const PREFIX_MATCH = 0.6;

/** A title containing the query verbatim is almost always the thing wanted. */
const PHRASE_BONUS = 15;

/** The fields a score is computed from, tokenized once per candidate. */
function fieldTokens(link) {
  return {
    title: tokenize(link.title),
    tags: tokenize((link.tags ?? []).join(' ')),
    summary: tokenize(link.summary),
    description: tokenize(link.description),
    author: tokenize(link.author),
    domain: tokenize(link.domain),
    url: tokenize(String(link.url ?? '').replace(/^https?:\/\/(www\.)?/i, '')),
  };
}

/**
 * How well one bookmark answers one query, by words alone.
 *
 * Each term scores once, at the value of the best field it was found in --
 * summed, not averaged, so a link matching three of the terms outranks one
 * matching a single term very well. A term found nowhere contributes nothing
 * rather than penalising, because in the relaxed pass most terms will be
 * missing from most results.
 */
export function scoreKeyword(link, terms, { query = '' } = {}) {
  const fields = fieldTokens(link);
  let score = 0;

  for (const term of terms) {
    // The same reduction the Mongo clause matches by -- see `matchPrefix`. The
    // two have to agree: if the filter matched a term the scorer did not, the
    // link would score zero against the very word that found it and sink to the
    // bottom of its own result list.
    const prefix = matchPrefix(term);
    let best = 0;

    for (const [field, tokens] of Object.entries(fields)) {
      for (const token of tokens) {
        if (!token.startsWith(prefix)) continue;

        // Both forms count as whole words. Typing "listings" against a page
        // that says "listings" is an exact match, and so is typing it against
        // one that says "listing" -- neither is the half-typed word that
        // `PREFIX_MATCH` exists to rank below a finished one.
        const quality = token === term || token === prefix ? EXACT_MATCH : PREFIX_MATCH;
        best = Math.max(best, FIELD_WEIGHTS[field] * quality);
      }
    }

    score += best;
  }

  // Rewards word order and adjacency, which the term-by-term sum above throws
  // away entirely: "server components" and "components server" score the same
  // without it.
  const phrase = query.trim().toLowerCase();
  if (phrase.includes(' ') && String(link.title ?? '').toLowerCase().includes(phrase)) {
    score += PHRASE_BONUS;
  }

  return score;
}

/**
 * Candidate links for a query, and whether the strict reading found any.
 *
 * Two passes, and the second is the point. Requiring every term is right for
 * the way people use a search box -- adding a word should narrow -- but wrong
 * for the way people describe a half-remembered page, which is in sentences.
 * "how do I make my backend faster" has no document containing all six words,
 * and an empty result there reads as a broken search rather than a strict one.
 *
 * So: try `all`, and fall back to `any` only when it returned nothing. The
 * fallback is reported back so the UI can say what happened instead of quietly
 * showing looser results.
 */
async function keywordCandidates(filter, terms) {
  if (!terms.length) return { candidates: [], relaxed: false };

  const strict = await Link.find(withKeyword(filter, terms, 'all')).limit(CANDIDATE_LIMIT);

  if (strict.length > 0 || terms.length === 1) {
    return { candidates: strict, relaxed: false };
  }

  // Short terms are dropped from the loose pass, and only from the loose pass.
  // Prefix-matching "a" or "do" *narrows* usefully when every term must match,
  // but ORed it matches most of a library and turns the fallback into "show
  // everything, ranked" -- measured on "how do I speed up a slow api", which
  // returned the entire corpus. The long words are the ones carrying meaning.
  const meaningful = terms.filter((term) => term.length >= 3);
  const loose = await Link.find(
    withKeyword(filter, meaningful.length > 0 ? meaningful : terms, 'any'),
  ).limit(CANDIDATE_LIMIT);

  return { candidates: loose, relaxed: loose.length > 0 };
}

/**
 * The semantic half: the user's words, as a vector, against the stored ones.
 *
 * Every failure here is caught and reported as "no semantic results" rather
 * than raised. Search must not stop working because a third party is having a
 * bad afternoon -- the keyword half is unaffected, still answers the majority
 * of queries, and a degraded search is enormously better than a 500.
 */
async function semanticCandidates(filter, query, { embed, enabled, logger }) {
  if (!enabled) return { matches: [], attempted: false, failed: false };

  try {
    const { vector } = await embed(query);
    const matches = (await nearestLinks({ filter, vector, limit: SEMANTIC_LIMIT })).filter(
      (match) => match.score >= MIN_SIMILARITY,
    );

    return { matches, attempted: true, failed: false };
  } catch (error) {
    logger.warn?.(`[search] semantic half unavailable, keywords only: ${error.message}`);
    return { matches: [], attempted: true, failed: true };
  }
}

/** Turns an ordered list of ids into `id -> reciprocal rank` contributions. */
function reciprocalRanks(ids, weight) {
  return new Map(ids.map((id, index) => [id, weight / (RRF_K + index + 1)]));
}

/**
 * Runs a search and returns one page of it.
 *
 * The shape matches `listLinks` exactly, because the dashboard calls one or the
 * other depending only on whether the search box has anything in it, and a
 * client that had to tell them apart would be a client that renders two
 * different result lists.
 */
export async function searchLinks({
  userId,
  params,
  embed = callProvider,
  // Injected rather than read inline, matching how the reaper takes
  // `enrichmentEnabled`: it is the seam the tests use to exercise the semantic
  // half without a provider, and it keeps the decision in one place.
  semanticEnabled = env.ENABLE_EMBEDDINGS,
  logger = console,
} = {}) {
  const { filter, skip, limit } = buildLinkQuery(userId, params);
  const terms = queryTerms(params.q);

  // Both halves at once: they hit different indexes and neither needs the
  // other's answer, so paying for them in sequence would only add latency to
  // the network call the semantic half is already waiting on.
  const [keyword, semantic] = await Promise.all([
    keywordCandidates(filter, terms),
    semanticCandidates(filter, params.q, { embed, enabled: semanticEnabled, logger }),
  ]);

  const byId = new Map(keyword.candidates.map((link) => [link.id, link]));

  const keywordOrder = keyword.candidates
    .map((link) => ({
      id: link.id,
      savedAt: link.savedAt,
      score: scoreKeyword(link, terms, { query: params.q }),
    }))
    // Recency breaks the tie, and the tie is common: "Redis" and "Redis Caching
    // Strategies" both score an exact title match for "redis". Without this the
    // order is whatever the index happened to return, which is stable enough to
    // look intentional and arbitrary enough to be wrong.
    .sort((a, b) => b.score - a.score || b.savedAt - a.savedAt)
    .map((entry) => entry.id);

  const semanticOrder = semantic.matches.map((match) => match.id);

  const keywordRanks = reciprocalRanks(keywordOrder, KEYWORD_WEIGHT);
  const semanticRanks = reciprocalRanks(semanticOrder, SEMANTIC_WEIGHT);

  const fused = [...new Set([...keywordOrder, ...semanticOrder])]
    .map((id) => ({ id, score: (keywordRanks.get(id) ?? 0) + (semanticRanks.get(id) ?? 0) }))
    .sort((a, b) => b.score - a.score);

  const ordered = await orderFor(params, fused, byId, filter);
  const page = ordered.slice(skip, skip + limit);

  // The semantic half returns ids, not documents, so anything it found that the
  // keyword half did not still has to be read. Only the page is loaded: fusing
  // ranks is cheap, and hydrating a hundred documents to show twenty is not.
  const documents = await hydrate(page, byId, filter);

  return {
    links: documents.map((link) => link.toPublicJSON()),
    page: params.page ?? 1,
    limit,
    total: ordered.length,
    hasMore: skip + page.length < ordered.length,
    // What the client tells the user about the results it is showing.
    search: {
      // No link contained every word typed, so these match some of them.
      relaxed: keyword.relaxed,
      // Whether meaning was part of the ranking, and whether it was meant to
      // be. `attempted && !matched` is an honest "nothing was close enough";
      // `failed` is "the provider did not answer", which is a different thing
      // and worth distinguishing when someone asks why a search got worse.
      semantic: semantic.attempted && !semantic.failed,
      semanticFailed: semantic.failed,
      semanticMatches: semantic.matches.length,
    },
  };
}

/**
 * Applies an explicit sort, if the user chose one, over the fused order.
 *
 * An explicit `newest` or `oldest` outranks relevance even during a search: the
 * user asked for an order, and silently overriding it would make the sort
 * control look broken whenever the search box was not empty. Relevance is the
 * default, and is the only meaning `relevance` has -- it needs a query to be
 * relevant to, which is why it is only reachable from here.
 */
async function orderFor(params, fused, byId, filter) {
  if (params.sort !== 'newest' && params.sort !== 'oldest') return fused;

  const missing = fused.filter((entry) => !byId.has(entry.id)).map((entry) => entry.id);
  const dates = new Map([...byId].map(([id, link]) => [id, link.savedAt]));

  // Sorting by date needs the date of every result, including the ones only the
  // semantic half found. Ids only -- the documents themselves are still loaded
  // a page at a time.
  if (missing.length > 0) {
    const rows = await Link.find({ ...filter, _id: { $in: missing } })
      .select('_id savedAt')
      .lean();

    for (const row of rows) dates.set(row._id.toString(), row.savedAt);
  }

  return [...fused].sort((a, b) => {
    const left = dates.get(a.id) ?? 0;
    const right = dates.get(b.id) ?? 0;

    return params.sort === 'newest' ? right - left : left - right;
  });
}

/**
 * Loads the documents for one page, in the order the ranking put them.
 *
 * `filter` is reapplied even though every id here came from a query that
 * already carried it. It is the one guarantee in this file that must not depend
 * on reasoning about an earlier function: an id reaching this point by any
 * route still cannot fetch a bookmark its owner did not ask for.
 */
async function hydrate(page, byId, filter) {
  const missing = page.filter((entry) => !byId.has(entry.id)).map((entry) => entry.id);

  if (missing.length > 0) {
    for (const link of await Link.find({ ...filter, _id: { $in: missing } })) {
      byId.set(link.id, link);
    }
  }

  return page.map((entry) => byId.get(entry.id)).filter(Boolean);
}
