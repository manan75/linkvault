import { safeFetch } from './safeFetch.js';
import { cleanText, safeImageUrl } from '../utils/sanitize.js';

/**
 * The published API for asking a site what a link is, instead of scraping it.
 *
 * This is the door Discord, Slack and every CMS on the internet use, and it is
 * the answer to a problem that has no server-side answer otherwise: production
 * returns **429 for the YouTube watch page** because Render's free instances
 * share outbound addresses with every other tenant. Measured, from the same
 * request `safeFetch` makes:
 *
 * ```
 *   youtube.com/watch?v=...           1,325KB of HTML, 429 from Render
 *   youtube.com/oembed?url=...          868 BYTES of JSON, 604ms
 *                                       title, author_name, thumbnail_url
 * ```
 *
 * There is a structural reason to expect this survives a datacenter address
 * where the watch page does not, rather than merely a hope: **oEmbed's entire
 * user base is servers.** Every embed on every CMS is a datacenter calling this
 * endpoint, so a provider cannot rate-limit datacenter traffic here without
 * breaking the integrations the endpoint exists to serve. The 429 on `/watch`
 * is anti-scraping; this is the sanctioned path.
 *
 * It is still an assumption until it is deployed, which is the running theme of
 * this project. If it does turn out to be throttled, the fallback is already in
 * place: a failure here returns null and the ordinary fetch runs.
 */

/**
 * Providers whose endpoint was verified to answer, with what it returned.
 *
 * Matched on the registrable host rather than a pattern over the whole URL, so
 * a URL merely *containing* `youtube.com` cannot steer the lookup. The endpoint
 * is ours, never the page's -- discovery via the page's own
 * `<link rel="alternate" type="application/json+oembed">` is deliberately not
 * implemented, because it would mean fetching the page (the thing that fails)
 * and then following a URL that page chose (an SSRF vector aimed straight at
 * the one function allowed to make outbound requests).
 */
export const PROVIDERS = [
  { hosts: ['youtube.com', 'youtu.be'], endpoint: 'https://www.youtube.com/oembed?format=json&url=' },
  { hosts: ['vimeo.com'], endpoint: 'https://vimeo.com/api/oembed.json?url=' },
  { hosts: ['soundcloud.com'], endpoint: 'https://soundcloud.com/oembed?format=json&url=' },
  { hosts: ['spotify.com'], endpoint: 'https://open.spotify.com/oembed?url=' },
  { hosts: ['flickr.com', 'flic.kr'], endpoint: 'https://www.flickr.com/services/oembed?format=json&url=' },
  { hosts: ['reddit.com'], endpoint: 'https://www.reddit.com/oembed?url=' },
];

/**
 * Short, and shorter than the page fetch it replaces.
 *
 * A provider that is slow to answer is not worth waiting on: the ordinary fetch
 * still has to run afterwards, and both share the worker's processing lease.
 */
const TIMEOUT_MS = 5_000;

/** These answers are a kilobyte. Anything near this cap is not an oEmbed reply. */
const MAX_BYTES = 64 * 1024;

/** `www.` and a trailing dot are noise; everything else identifies the host. */
const bareHost = (hostname) => hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

/** Whether `hostname` is `host` or a subdomain of it -- never a mere suffix match. */
const matches = (hostname, host) => hostname === host || hostname.endsWith(`.${host}`);

/** The endpoint to ask about this URL, or null if no provider covers it. */
export function endpointFor(url) {
  let hostname;

  try {
    hostname = bareHost(new URL(url).hostname);
  } catch {
    return null;
  }

  const provider = PROVIDERS.find(({ hosts }) => hosts.some((host) => matches(hostname, host)));

  return provider ? provider.endpoint + encodeURIComponent(url) : null;
}

const LIMITS = { title: 300, author: 200 };

/**
 * Turns a provider's JSON into the fields a bookmark stores.
 *
 * The response is third-party data and is sanitised exactly as scraped metadata
 * is. A provider is more likely to be well behaved than an arbitrary page; that
 * is not a reason to trust it, and `thumbnail_url` ends up in an `<img src>`
 * either way.
 *
 * `description` is absent by design, not by omission: oEmbed has no such field.
 * A link named by this route therefore reaches enrichment with a title and no
 * description, which `hasEnoughToEnrich` accepts -- tags, and an honestly empty
 * summary, rather than an invented one.
 */
export function fieldsFromOembed(payload, { pageUrl }) {
  if (!payload || typeof payload !== 'object') return null;

  const title = cleanText(payload.title, LIMITS.title);

  // A reply with no title has told us nothing the URL did not already say, and
  // returning it would suppress the page fetch that might still work.
  if (!title) return null;

  return {
    title,
    description: '',
    author: cleanText(payload.author_name, LIMITS.author),
    thumbnail: safeImageUrl(payload.thumbnail_url, pageUrl),
    // oEmbed carries no favicon. The conventional path is a guess, and the same
    // guess `parseMetadata` already makes -- the client hides one that 404s.
    favicon: safeImageUrl('/favicon.ico', pageUrl),
  };
}

/**
 * Asks the provider about a URL, or returns null.
 *
 * **Never throws.** Every failure -- no provider, a 404 for a video that does
 * not exist, a timeout, malformed JSON -- means "this route had nothing to say"
 * and the caller falls through to fetching the page. An optimisation that could
 * fail a bookmark would be worse than no optimisation.
 */
export async function fetchOembed(url, { fetchJson = safeFetch } = {}) {
  const endpoint = endpointFor(url);
  if (!endpoint) return null;

  try {
    const response = await fetchJson(endpoint, {
      accept: 'application/json',
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_BYTES,
    });

    return fieldsFromOembed(JSON.parse(response.body.toString('utf8')), { pageUrl: url });
  } catch {
    return null;
  }
}
