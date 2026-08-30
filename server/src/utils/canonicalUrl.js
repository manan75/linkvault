import { ApiError } from './ApiError.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Query parameters that identify a campaign or referrer rather than a page.
 * Stripping them keeps the same article shared from two places as one bookmark.
 */
const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'ref', 'mc_eid']);

function isTrackingParam(name) {
  const key = name.toLowerCase();
  return TRACKING_PARAMS.has(key) || TRACKING_PARAM_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function invalidUrl(message) {
  return ApiError.badRequest('Validation failed', [{ field: 'url', message }]);
}

/**
 * Parses user input into a URL. A missing scheme is filled in with `https:`
 * so that pasting `example.com/article` works the way people expect.
 */
function parseUrl(input) {
  const trimmed = String(input ?? '').trim();

  if (!trimmed) throw invalidUrl('A URL is required');

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw invalidUrl('Enter a valid URL');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw invalidUrl('Only http and https URLs can be saved');
  }

  // A hostname with no dot is either malformed or an internal name we cannot fetch.
  if (!url.hostname.includes('.')) throw invalidUrl('Enter a valid URL');

  return { url, href: withScheme };
}

/** The hostname a bookmark is grouped and filtered by, without a `www.` prefix. */
export function domainOf(url) {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * Reduces cosmetically different URLs for the same page to one string, which is
 * what `(userId, canonicalUrl)` uniqueness -- and later worker idempotency --
 * compares.
 *
 * Query parameters other than known trackers are preserved in their original
 * order: `?v=` and `?id=` routinely identify the page, so stripping them
 * wholesale would merge genuinely different bookmarks into one.
 */
export function canonicalizeUrl(input) {
  const { url, href } = parseUrl(input);

  url.hash = '';
  url.hostname = domainOf(url);

  for (const name of [...url.searchParams.keys()]) {
    if (isTrackingParam(name)) url.searchParams.delete(name);
  }

  // `URL` normalises an empty path to "/", which carries no meaning to strip;
  // a trailing slash on a deeper path does not distinguish a page.
  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  return {
    // What the user pasted, with only a missing scheme filled in, so the stored
    // link still opens in a browser.
    url: href,
    canonicalUrl: url.toString(),
    domain: domainOf(url),
  };
}
