/**
 * The vocabulary a bookmark can be found by, and how a typed query is turned
 * into terms to match against it.
 *
 * This replaces MongoDB's `$text` index, which could not do the two things a
 * search box has to do. Measured against a real corpus before it was removed:
 *
 * ```
 * "reac"  -> 0 hits     "kafk" -> 0     "postg" -> 0     "javas" -> 0
 * "kafka react postgres" -> 3 hits (every one of them)
 * ```
 *
 * `$text` matches whole words after stemming, so nothing appears until the
 * final character of a word is typed -- and multi-word queries are OR, so every
 * extra word *widens* the result set instead of narrowing it. Neither is
 * tunable; `$text` has no prefix operator and no AND. A few prefixes did appear
 * to work ("redi", "cach"), but only because the English stemmer happens to map
 * "redis" to "redi" and "caching" to "cach". That is a coincidence, not a
 * feature, and it is why the problem read as intermittent.
 *
 * So the tokens are materialised onto the document instead. An array field with
 * a multikey index gives prefix matching (an anchored regex uses the index) and
 * AND (one clause per term), which is what typing into a search box means.
 */

/**
 * Tokens shorter than this are not indexed.
 *
 * Query terms are not held to it: matching is by prefix, so typing "c" still
 * finds "caching" against a two-character-minimum index. The bound only keeps
 * the stray single letters that fall out of splitting URLs and punctuation out
 * of every document's token array.
 */
const MIN_TOKEN_LENGTH = 2;

/**
 * A ceiling on one document's token array, so a long description cannot bloat
 * the index. Ordered by field weight, so the ones that matter survive a trim.
 */
const MAX_TOKENS_PER_LINK = 400;

/** Characters that separate words. Everything that is not a letter or a digit. */
const SEPARATORS = /[^a-z0-9]+/i;

/**
 * Splits a run of letters at a lower-to-upper boundary, so "PostgreSQL" yields
 * "postgre" and "sql" alongside "postgresql", and "JavaScript" yields "java"
 * and "script".
 *
 * This is what makes searching "SQL" find "PostgreSQL". `$text` could not: it
 * saw one token and a query for part of it matched nothing.
 */
function splitCamelCase(word) {
  return word.split(/(?<=[a-z0-9])(?=[A-Z])/);
}

/**
 * Turns arbitrary text into the tokens it can be found by.
 *
 * Deliberately not stemmed. Prefix matching already covers the common English
 * suffix ("caching" is found by "cach"), and a stemmer is what made the old
 * behaviour unpredictable -- it silently rewrote both the document and the
 * query, so whether a prefix worked depended on an invisible transformation.
 */
export function tokenize(text, { minLength = MIN_TOKEN_LENGTH } = {}) {
  if (!text) return [];

  const tokens = [];

  for (const word of String(text).split(SEPARATORS)) {
    if (!word) continue;

    // The whole word first, then its camel-case parts. Both are wanted: a user
    // may type either "postgresql" or "sql".
    const parts = splitCamelCase(word);
    const candidates = parts.length > 1 ? [word, ...parts] : [word];

    for (const candidate of candidates) {
      const lowered = candidate.toLowerCase();
      if (lowered.length >= minLength) tokens.push(lowered);
    }
  }

  return tokens;
}

/**
 * The fields a bookmark is searchable by, most significant first.
 *
 * `capture.text` is deliberately absent. It is a whole rendered page and would
 * add thousands of tokens per link for a handful of extra matches, drowning the
 * signal from the title in the noise of a navigation menu. It is the *embedding*
 * input, where a dense vector can weigh it -- not the keyword index.
 */
export function searchableFields(link) {
  return [
    link.title,
    (link.tags ?? []).join(' '),
    link.summary,
    link.description,
    link.author,
    link.domain,
    // Path and query only. The scheme and the "www" are on every link and
    // discriminate nothing.
    String(link.url ?? '').replace(/^https?:\/\/(www\.)?/i, ''),
  ];
}

/**
 * The de-duplicated token set stored on the document.
 *
 * A set, not a bag: this array is a filter, not a score. Term frequency would
 * have to be stored per field to be worth anything, and ranking is computed
 * from the document's own fields at query time anyway -- see `scoreKeyword`.
 */
export function buildSearchTokens(link) {
  const seen = new Set();

  for (const field of searchableFields(link)) {
    for (const token of tokenize(field)) {
      seen.add(token);
      if (seen.size >= MAX_TOKENS_PER_LINK) return [...seen];
    }
  }

  return [...seen];
}

/** Escapes a term so it can be embedded in an anchored regular expression. */
function escapeRegex(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The terms of a typed query.
 *
 * The same tokenizer as the document side, which is the only way the two can
 * agree -- with one difference: single characters are kept. Matching is by
 * prefix, so "r" is a perfectly good term against a two-character-minimum
 * index, and dropping it would mean the first keystroke of every search showed
 * an empty library.
 *
 * No stopword list. With AND semantics a stopword can only narrow, and dropping
 * words the user actually typed is a worse surprise than matching them.
 */
export function queryTerms(q) {
  return [...new Set(tokenize(q, { minLength: 1 }))];
}

/**
 * Suffixes stripped from a *query* term, longest first.
 *
 * Prefix matching is one-directional: a document token has to begin with what
 * was typed. That covers the common case of typing less than the page says
 * ("listing" finds "Listings"), and misses the opposite one entirely. Measured
 * against a real bookmark whose summary read "Listing of open roles":
 *
 * ```
 * "listing"  -> 1 hit
 * "listings" -> 0 hits
 * ```
 *
 * Typing a plural when the page used a singular is not an unusual thing to do,
 * and an empty result there reads exactly like the bug this file was written to
 * fix. So the *query* is reduced to its stem, and the stem is what gets matched
 * as a prefix -- which needs no second clause, because a stem is a prefix of
 * the word it came from: "^listing" matches the token "listing" and the token
 * "listings" both.
 *
 * Deliberately not a stemmer, and deliberately query-side only. The document
 * side stays literal, so what is stored remains exactly what was written, and
 * the transformation is applied in one place to one short string rather than
 * invisibly to both sides of the comparison -- which is what made `$text`
 * unpredictable.
 */
const INFLECTIONAL_SUFFIXES = ['ies', 'ing', 'ers', 'es', 'ed', 'er', 's'];

/**
 * The shortest stem worth matching on.
 *
 * A floor is the whole safety of the rule above, because stripping widens: with
 * no bound, "cars" becomes "car" and finds "careers", and "tags" becomes "tag"
 * and finds "target". Four characters keeps the genuine inflections
 * ("listings", "caching", "libraries", "watches") and rejects the short words
 * where the stem carries too little meaning to be worth the noise.
 */
const MIN_STEM_LENGTH = 4;

/**
 * The prefix a query term is actually matched by.
 *
 * The most aggressive stem that clears the floor, because stems nest: "librar"
 * matches everything "librari" would and "library" as well. One literal
 * anchored prefix, so this still costs a single index seek -- an alternation of
 * several stems would not.
 */
export function matchPrefix(term) {
  let prefix = term;

  for (const suffix of INFLECTIONAL_SUFFIXES) {
    if (!term.endsWith(suffix)) continue;

    const stem = term.slice(0, -suffix.length);
    if (stem.length >= MIN_STEM_LENGTH && stem.length < prefix.length) prefix = stem;
  }

  return prefix;
}

/**
 * A Mongo clause matching documents whose tokens begin with `term`.
 *
 * Anchored, so the multikey index on `searchTokens` can serve it. An unanchored
 * regex would work and would also read every key in the index.
 */
export function prefixClause(term) {
  return { searchTokens: { $regex: `^${escapeRegex(matchPrefix(term))}` } };
}
