/**
 * Tag hygiene, applied to whatever the model returns.
 *
 * These are the deterministic guards from §3 of the Phase 5 plan, and they sit
 * *outside* the model call on purpose: tag consistency is the thing most likely
 * to rot, and it must not depend on the model behaving. The model is asked to
 * reuse the user's existing vocabulary; this makes sure that even when it
 * slips, `React` and `react` can never become two entries in the sidebar.
 */

/**
 * Three, lowered from five.
 *
 * Five was chosen for readability on a card, which was the wrong thing to
 * optimise. A tag exists to gather links: one that lands on a single bookmark
 * is a label nobody will ever click, and asking for five guarantees the model
 * pads the list to reach the number. Real output on an Instagram reel was
 * `instagram`, `instagram-reel`, `kpop`, `kpop-idol` -- four tags naming two
 * things, and the sidebar fills with entries of size one.
 *
 * Three still allows a subject, a technology and a domain, which covers what
 * this actually needs to express.
 */
export const MAX_AUTO_TAGS = 3;

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
 * Whether `tag` only restates something already accepted.
 *
 * The shape this catches is a broad tag followed by a narrowing of the same
 * tag: `instagram` then `instagram-reel`, `kpop` then `kpop-idol`,
 * `machine-learning` then `machine-learning-models`. Both are on the same
 * bookmark, so the narrow one adds no way to find it that the broad one did not
 * already provide -- it only splits the vocabulary in two.
 *
 * Matched on whole words, so `react` does not suppress `preact` and `ml` does
 * not suppress `html`. It compares against the tags *kept so far* rather than
 * the whole candidate list, which means the broad tag wins when the model
 * offers it first -- and it reliably does, because a model asked for tags
 * writes the general one before its refinement.
 *
 * The known cost: `react` arriving before `react-native` suppresses
 * `react-native`, and those are genuinely different things. Accepted. A React
 * Native page filed under `react` is findable and not wrong; a vault where
 * every subject exists at two granularities is neither.
 */
function restates(tag, kept) {
  const words = tag.toLowerCase().split('-');

  return kept.some((existing) => {
    const other = existing.toLowerCase().split('-');
    if (other.length >= words.length) return false;

    return other.every((word, index) => word === words[index]);
  });
}

/**
 * Normalises a list, drops entries that restate one already kept, adopts the
 * casing the user's vocabulary already uses, and caps the count.
 *
 * The case snap is the guard that makes drift impossible rather than unlikely.
 * `normalizeTag` lowercases, so it only bites on a vocabulary that already
 * holds a mixed-case tag from before this rule existed -- but that is exactly
 * the case where a silent second entry would appear in the sidebar.
 *
 * The redundancy filter sits here, outside the model call, for the same reason
 * everything else in this file does: the prompt asks for non-overlapping tags,
 * and the prompt is a request. This is the guarantee.
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
    if (restates(tag, tags)) continue;

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
