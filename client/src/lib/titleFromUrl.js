/**
 * A readable title guessed from the URL itself, for bookmarks whose page could
 * not be fetched.
 *
 * Display-only, and deliberately never written back to the bookmark. The worker
 * fills a field only when it is still empty (`completeLink` in
 * server/src/workers/linkQueue.js), so a guess stored as `title` would
 * permanently block the real one: a later retry would fetch the page, find the
 * title already occupied, and keep the guess forever.
 *
 * Guesses only when the URL actually carries words. `/problems/two-sum/` does.
 * `/watch?v=dQw4w9WgXcQ` does not, and inventing "Watch" for every YouTube link
 * would be worse than showing the address.
 */

/** Path segments that are routing furniture rather than the name of anything. */
const GENERIC_SEGMENTS = new Set([
  'watch', 'index', 'home', 'default', 'main',
  'post', 'posts', 'p', 'status', 'v', 'dp', 'item', 'entry',
  'article', 'articles', 'blog', 'story', 'video', 'videos',
  'page', 'view', 'read', 'en', 'en-us', 'amp', 'abs', 'pdf',
]);

const TRAILING_EXTENSION = /\.(html?|php|aspx?|jsp|md|htm)$/i;

/**
 * Long runs of mixed letters and digits are identifiers, not words: a commit
 * hash, a YouTube id, a database key. Dropped from the title rather than
 * rejecting the whole segment, so `post-8f3a2b1c9d` can still yield `Post`.
 */
const isOpaque = (part) => /^[0-9a-f]{6,}$/i.test(part) || /^[A-Za-z0-9]{12,}$/.test(part);

/** Splits a slug into the words it is actually made of, discarding identifiers. */
function wordsOf(segment) {
  return segment
    .split(/[-_+.]+/)
    .filter((part) => part && !isOpaque(part));
}

const isGeneric = (words) => GENERIC_SEGMENTS.has(words.join('-').toLowerCase());

/** Whether these words amount to a name a person would recognise. */
function isNameLike(words) {
  if (words.length === 0) return false;
  // At least one real word, so `b-1234567` and `12345` are rejected while
  // `top-10-databases` is kept.
  return words.some((word) => /^[A-Za-z]{3,}$/.test(word));
}

/** Kept lowercase inside a title, but never as the first word. */
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'is', 'are',
  'of', 'on', 'or', 'the', 'to', 'via', 'with',
]);

const titleCase = (words) =>
  words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && SMALL_WORDS.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');

/**
 * The URL with the scheme and any trailing slash removed -- what to show when
 * the address carries no words to build a name from. Still strictly better than
 * the bare domain, which the line beneath the title already repeats.
 */
export function prettyUrl(url) {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/**
 * Returns a guessed title, or null when the URL carries nothing name-like.
 *
 * Segments are walked from the end because that is where the specific name
 * lives: `/problems/two-sum/` should yield "Two Sum", not "Problems".
 */
export function titleFromUrl(url) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);

  for (let i = segments.length - 1; i >= 0; i -= 1) {
    let segment;

    try {
      segment = decodeURIComponent(segments[i]);
    } catch {
      // A malformed escape is not worth failing the whole guess over.
      segment = segments[i];
    }

    const words = wordsOf(segment.replace(TRAILING_EXTENSION, ''));

    // A generic segment marks the end of the useful part of the path: what
    // follows it is an identifier and what precedes it is a container, not a
    // name. `/someone/status/1234567890123` must not become "Someone" -- the
    // tweet is not called that, and the author already has its own field.
    if (isGeneric(words)) return null;

    if (isNameLike(words)) {
      const title = titleCase(words);
      return title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
    }
  }

  return null;
}
