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

/**
 * Path segments that are routing furniture rather than the name of anything.
 *
 * The social-video shapes -- `reel`, `reels`, `shorts`, `clip` -- are here for
 * the same reason `watch` is: `instagram.com/reel/C8xYz1AbCdE/` would otherwise
 * be titled "Reel", which is a category, not a name, and every reel in the
 * vault would carry it. The address itself at least identifies which one.
 */
const GENERIC_SEGMENTS = new Set([
  'watch', 'index', 'home', 'default', 'main',
  'post', 'posts', 'p', 'status', 'statuses', 'v', 'dp', 'item', 'entry',
  'article', 'articles', 'blog', 'story', 'stories', 'video', 'videos',
  'reel', 'reels', 'shorts', 'short', 'clip', 'clips', 'live', 'embed',
  'page', 'view', 'read', 'en', 'en-us', 'amp', 'abs', 'pdf',
  'gallery', 'photo', 'photos', 'image', 'images', 'track', 'episode',
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

/** A domain, with the noise that stops two spellings of it comparing equal. */
const bareDomain = (value) => value.trim().toLowerCase().replace(/^www\./, '').replace(/\/+$/, '');

/** The site's name without its suffix: `instagram.com` -> `instagram`. */
const siteName = (domain) => bareDomain(domain).split('.')[0];

/**
 * Whether a stored title actually names the page, or only names the site.
 *
 * Extraction no longer writes the domain into `title`
 * (`server/src/services/metadataParser.js`), but every bookmark saved before
 * that change still carries it, and plenty of pages genuinely title themselves
 * after their site -- a blocked Instagram page comes back titled `Instagram`.
 * Either way the word is already printed on the metadata line directly beneath
 * the title, so spending the headline on it says nothing twice.
 *
 * The suffix-stripped comparison is the deliberate part, and it does cost
 * something: a page at `redis.io` legitimately called "Redis" loses its title
 * and is named from its path instead. That is an acceptable trade -- the path
 * is more specific than the site name in every case where the two differ.
 */
export function isRealTitle(title, domain) {
  if (!title) return false;

  const named = bareDomain(title);
  return named !== bareDomain(domain ?? '') && named !== siteName(domain ?? '');
}

/**
 * The best name available for a bookmark: its own title, else one read out of
 * the URL's path, else the address itself.
 */
export function displayTitle({ title, url, domain }) {
  if (isRealTitle(title, domain)) return title;
  return titleFromUrl(url) ?? prettyUrl(url);
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
