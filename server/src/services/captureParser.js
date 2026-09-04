import { cleanText, safeImageUrl } from '../utils/sanitize.js';

/**
 * The trust boundary for what the browser extension sends.
 *
 * `CLAUDE.md` §7: never trust fetched webpage content. A capture *is* fetched
 * webpage content -- it is the DOM of an arbitrary page, quite possibly one an
 * attacker controls. The only thing that changed is the door it came through,
 * and arriving with a valid credential attached is exactly what makes it feel
 * trusted. It is not.
 *
 * So this file is deliberately shaped like `metadataParser.js`: same
 * `cleanText`, same `safeImageUrl`, same limits, producing the same field names
 * the metadata worker already knows how to write. The worker's completion path
 * cannot tell which parser produced its input, which is the property that keeps
 * one state machine instead of two.
 */

const LIMITS = { title: 300, description: 2000, author: 200 };

/**
 * How much page text is kept.
 *
 * Four kilobytes is roughly the first two screens of an article, which is where
 * a page says what it is about -- and it is what enrichment and, later, the
 * Phase 6 embedding actually need. At ten thousand links it is about 40MB,
 * which fits Atlas M0 with room left; storing the whole page would not.
 */
export const MAX_CAPTURE_TEXT = 4000;

/**
 * Collapses captured page text, keeping paragraph breaks.
 *
 * `cleanText` flattens all whitespace to single spaces, which is right for a
 * title and wrong for a body: the blank lines between paragraphs are most of
 * what tells a summariser where one idea ends. So control characters and
 * runaway blank runs go, and a single newline survives.
 */
export function cleanCaptureText(value, maxLength = MAX_CAPTURE_TEXT) {
  if (typeof value !== 'string') return '';

  const text = value
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ *\n */g, '\n')
    .trim();

  if (text.length <= maxLength) return text;

  // Cut at the last paragraph or sentence boundary inside the budget, so the
  // excerpt ends somewhere a reader would stop rather than mid-word.
  const cut = text.slice(0, maxLength);
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));

  return (boundary > maxLength - 500 ? cut.slice(0, boundary) : cut).trimEnd();
}

/**
 * Turns a raw capture payload into the fields a link stores.
 *
 * `pageUrl` is what relative image references resolve against, exactly as
 * `parseMetadata` resolves against the URL the fetch ended at. It is the URL
 * the extension says it captured, so it is untrusted too -- `safeImageUrl`
 * rejects anything that does not resolve to http(s), which is what stops a
 * `javascript:` favicon becoming stored XSS in the dashboard.
 */
export function parseCapture(capture, { pageUrl } = {}) {
  if (!capture || typeof capture !== 'object') return null;

  const fields = {
    title: cleanText(capture.title, LIMITS.title),
    description: cleanText(capture.description, LIMITS.description),
    author: cleanText(capture.author, LIMITS.author),
    favicon: safeImageUrl(capture.favicon, pageUrl),
    thumbnail: safeImageUrl(capture.thumbnail, pageUrl),
    text: cleanCaptureText(capture.text),
  };

  // A capture that survived sanitising with nothing in it is not a capture.
  // Storing it would make the worker skip the fetch and complete an empty
  // bookmark, which is strictly worse than trying the network.
  const hasContent = Object.values(fields).some(Boolean);

  return hasContent ? { ...fields, capturedAt: new Date() } : null;
}

/** The subset a completed bookmark is filled from. `text` is kept, not shown. */
export function fieldsFromCapture(capture) {
  if (!capture) return null;

  return {
    title: capture.title,
    description: capture.description,
    author: capture.author,
    favicon: capture.favicon,
    thumbnail: capture.thumbnail,
  };
}
