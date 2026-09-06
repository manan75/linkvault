import { Link } from '../models/Link.js';
import { buildLinkQuery, queryTerms, withKeyword } from './linkQuery.js';
import { tokenize } from './searchTokens.js';

/**
 * Ranked search over one user's bookmarks.
 *
 * Ranking happens here, in Node, rather than in the database. That is a
 * deliberate choice and worth stating, because "sort in the database" is
 * usually right:
 *
 * - The old `$text` ranking was the only ranking MongoDB offers without Atlas
 *   Search, and it came bolted to the matching behaviour that had to go.
 *   Keeping `$meta: 'textScore'` would have meant keeping `$text`.
 * - `MAX_LINKS_PER_USER` is 100, and the filter is anchored to one owner on an
 *   index that starts with `userId`. The candidate set is small by construction.
 * - Semantic ranking has to happen here anyway (see `vectorSearch.js`), and one
 *   scoring pass that both halves feed is far easier to reason about than a
 *   database ordering that a second pass then has to disturb.
 *
 * The bound is `CANDIDATE_LIMIT`, and it is the thing to watch: past it, ranking
 * is over a truncated set. It is deliberately far above the per-user cap.
 */

/** How many matching links may be ranked. Well above `MAX_LINKS_PER_USER`. */
export const CANDIDATE_LIMIT = 500;

/**
 * What a match is worth, by where it was found.
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
 * How well one bookmark answers one query.
 *
 * Each term scores once, at the value of the best field it was found in --
 * summed, not averaged, so a link matching three of the terms outranks one
 * matching a single term very well. A term found nowhere contributes nothing
 * rather than penalising, because in `any` mode most terms will be missing.
 */
export function scoreKeyword(link, terms, { query = '' } = {}) {
  const fields = fieldTokens(link);
  let score = 0;

  for (const term of terms) {
    let best = 0;

    for (const [field, tokens] of Object.entries(fields)) {
      for (const token of tokens) {
        if (!token.startsWith(term)) continue;

        const quality = token === term ? EXACT_MATCH : PREFIX_MATCH;
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
 * fallback is reported back to the caller so the UI can say what happened
 * instead of quietly showing looser results.
 */
async function keywordCandidates(filter, terms) {
  if (!terms.length) return { candidates: [], relaxed: false };

  const strict = await Link.find(withKeyword(filter, terms, 'all')).limit(CANDIDATE_LIMIT);

  if (strict.length > 0 || terms.length === 1) {
    return { candidates: strict, relaxed: false };
  }

  const loose = await Link.find(withKeyword(filter, terms, 'any')).limit(CANDIDATE_LIMIT);

  return { candidates: loose, relaxed: loose.length > 0 };
}

/**
 * Runs a search and returns one page of it.
 *
 * The shape matches `listLinks` exactly, because the dashboard calls one or the
 * other depending only on whether the search box has anything in it, and a
 * client that had to tell them apart would be a client that renders two
 * different result lists.
 */
export async function searchLinks({ userId, params }) {
  const { filter, skip, limit } = buildLinkQuery(userId, params);
  const terms = queryTerms(params.q);

  const { candidates, relaxed } = await keywordCandidates(filter, terms);

  const scored = candidates.map((link) => ({
    link,
    score: scoreKeyword(link, terms, { query: params.q }),
  }));

  // An explicit `newest` or `oldest` outranks relevance even during a search:
  // the user asked for an order, and silently overriding it would make the sort
  // control look broken whenever the search box was not empty. Relevance is the
  // default, and the only meaning `relevance` has -- it needs a query to be
  // relevant to, which is why it is only reachable from here.
  const ranked =
    params.sort === 'newest' || params.sort === 'oldest'
      ? scored.sort((a, b) =>
          params.sort === 'newest'
            ? b.link.savedAt - a.link.savedAt
            : a.link.savedAt - b.link.savedAt,
        )
      : // Score first, then recency: two equally good matches should come back
        // newest-first rather than in whatever order the index handed them over.
        scored.sort((a, b) => b.score - a.score || b.link.savedAt - a.link.savedAt);

  const page = ranked.slice(skip, skip + limit);

  return {
    links: page.map(({ link }) => link.toPublicJSON()),
    page: params.page ?? 1,
    limit,
    total: ranked.length,
    hasMore: skip + page.length < ranked.length,
    // True when no single link contained every word typed, so the results are
    // links matching some of them. The client says so above the list.
    relaxed,
  };
}
