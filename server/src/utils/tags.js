/**
 * Tag hygiene, applied to whatever the model returns.
 *
 * These are the deterministic guards from §3 of the Phase 5 plan, and they sit
 * *outside* the model call on purpose: tag consistency is the thing most likely
 * to rot, and it must not depend on the model behaving. The model is asked to
 * reuse the user's existing vocabulary; this makes sure that even when it
 * slips, `React` and `react` can never become two entries in the sidebar.
 */

/** Five is enough to be useful and few enough to stay readable on a card. */
export const MAX_AUTO_TAGS = 5;

/** The schema's own limit. Anything longer is not a label, it is a sentence. */
const MAX_TAG_LENGTH = 40;

/**
 * Turns one candidate into the canonical form, or null if nothing usable is
 * left.
 *
 * Deliberately *not* singularising: it breaks `ops`, `docs`, `aws` and `k8s`,
 * and buys very little in return.
 */
export function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;

  const tag = raw
    .trim()
    .toLowerCase()
    // "machine learning" and "machine_learning" are the same tag as
    // "machine-learning"; the model uses all three depending on the day.
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    // Trailing punctuation is a model artefact, never something a user meant.
    .replace(/^[^a-z0-9]+|[^a-z0-9+#]+$/g, '');

  if (!tag || tag.length > MAX_TAG_LENGTH) return null;

  return tag;
}

/**
 * Normalises a list, adopts the casing the user's vocabulary already uses, and
 * caps the count.
 *
 * The case snap is the guard that makes drift impossible rather than unlikely.
 * `normalizeTag` lowercases, so it only bites on a vocabulary that already
 * holds a mixed-case tag from before this rule existed -- but that is exactly
 * the case where a silent second entry would appear in the sidebar.
 */
export function normalizeTags(candidates, { vocabulary = [], limit = MAX_AUTO_TAGS } = {}) {
  const existing = new Map(vocabulary.map((tag) => [tag.toLowerCase(), tag]));
  const seen = new Set();
  const tags = [];

  for (const candidate of candidates ?? []) {
    const normalized = normalizeTag(candidate);
    if (!normalized) continue;

    const tag = existing.get(normalized) ?? normalized;
    if (seen.has(tag.toLowerCase())) continue;

    seen.add(tag.toLowerCase());
    tags.push(tag);

    if (tags.length >= limit) break;
  }

  return tags;
}

/**
 * Adds new tags to a link's existing set without disturbing what is there.
 *
 * Order is preserved and comparison is case-insensitive, so re-enriching a link
 * that already carries `react` never appends a second `React`.
 */
export function mergeTags(current = [], additions = []) {
  const seen = new Set(current.map((tag) => tag.toLowerCase()));
  const merged = [...current];

  for (const tag of additions) {
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    merged.push(tag);
  }

  return merged;
}
