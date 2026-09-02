import * as cheerio from 'cheerio';

import { cleanText, safeImageUrl } from '../utils/sanitize.js';

/**
 * Turns a fetched HTML document into the handful of fields a bookmark shows.
 *
 * Parsing only. Cheerio builds a tree and never runs a script, which is the
 * property that matters here -- `CLAUDE.md` rules out anything that would
 * execute page JavaScript.
 *
 * Every relative URL is resolved against the URL the fetch *ended* at, not the
 * one the user pasted: a page redirected to another host references its assets
 * relative to where it actually lives.
 */

const LIMITS = { title: 300, description: 2000, author: 200 };

/** First non-empty value wins, per the Phase 3 precedence table. */
function firstOf(...values) {
  return values.find((value) => value) ?? '';
}

/** Reads `<meta property="..">` or `<meta name="..">`, whichever the page used. */
function meta($, key) {
  return (
    $(`meta[property="${key}"]`).attr('content') ?? $(`meta[name="${key}"]`).attr('content') ?? ''
  );
}

/**
 * Digs an author name out of JSON-LD, which spells it as a string, an object
 * with a `name`, or an array of either. Malformed JSON-LD is common enough that
 * a parse failure is simply the absence of an answer.
 */
function jsonLdAuthor($) {
  const nameOf = (author) => {
    if (typeof author === 'string') return author;
    if (Array.isArray(author)) return nameOf(author[0]);
    if (author && typeof author === 'object') return typeof author.name === 'string' ? author.name : '';
    return '';
  };

  for (const element of $('script[type="application/ld+json"]').toArray()) {
    let parsed;
    try {
      parsed = JSON.parse($(element).text());
    } catch {
      continue;
    }

    for (const node of [].concat(parsed, parsed?.['@graph'] ?? [])) {
      const name = nameOf(node?.author);
      if (name) return name;
    }
  }

  return '';
}

/**
 * Picks the favicon, preferring a declared one and falling back to the
 * conventional `/favicon.ico`. The fallback is a guess, which is why a broken
 * favicon is hidden rather than shown as a placeholder in the client.
 */
function faviconFrom($, finalUrl) {
  const declared = $('link[rel~="icon"], link[rel="apple-touch-icon"]')
    .toArray()
    .map((element) => $(element).attr('href'))
    .find(Boolean);

  return firstOf(safeImageUrl(declared, finalUrl), safeImageUrl('/favicon.ico', finalUrl));
}

/**
 * Decodes the response body.
 *
 * The charset comes from the header when there is one and from `<meta charset>`
 * otherwise -- read from the raw bytes, since the document has to be decoded
 * before it can be parsed. An unknown label falls back to UTF-8 rather than
 * throwing: a slightly mangled title beats no bookmark at all.
 */
export function decodeHtml(body, contentType = '') {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const fromDocument = /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString('latin1'))?.[1];
  const charset = (fromHeader ?? fromDocument ?? 'utf-8').toLowerCase();

  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return body.toString('utf8');
  }
}

/**
 * `domain` is the fallback title, so a page with no usable metadata at all
 * still produces a labelled bookmark.
 */
export function parseMetadata(html, { finalUrl, domain }) {
  const $ = cheerio.load(html);

  return {
    title: cleanText(
      firstOf(meta($, 'og:title'), meta($, 'twitter:title'), $('title').first().text(), domain),
      LIMITS.title,
    ),
    description: cleanText(
      firstOf(meta($, 'og:description'), meta($, 'twitter:description'), meta($, 'description')),
      LIMITS.description,
    ),
    author: cleanText(
      firstOf(meta($, 'author'), meta($, 'article:author'), jsonLdAuthor($)),
      LIMITS.author,
    ),
    thumbnail: firstOf(
      safeImageUrl(meta($, 'og:image'), finalUrl),
      safeImageUrl(meta($, 'twitter:image'), finalUrl),
    ),
    favicon: faviconFrom($, finalUrl),
  };
}
