/**
 * Nothing fetched from a webpage reaches the database without passing through
 * here. `CLAUDE.md`: never trust fetched webpage content.
 */

// eslint-disable-next-line no-control-regex -- stripping control characters is the point.
const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Reduces a scraped string to one line of plain text within the schema's limit.
 *
 * Pages routinely put newlines, tabs and stray control bytes inside a `content`
 * attribute; a title with a NUL in it is not a title.
 */
export function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';

  const text = value.replace(CONTROL_CHARACTERS, '').replace(/\s+/g, ' ').trim();

  if (text.length <= maxLength) return text;

  // Cut on a word boundary when one is close enough that the trim is not
  // obviously mid-word.
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLength - 40 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * Resolves a scraped image reference against the page it came from and returns
 * it only if it is safe to put in an `<img src>`.
 *
 * The protocol check is not cosmetic: favicons and thumbnails are rendered
 * directly by the client, so a stored `javascript:` URL would be stored XSS.
 * `data:` is refused too -- it is unbounded and there is no reason for a page to
 * hand us one.
 */
export function safeImageUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value.trim()) return '';

  let resolved;
  try {
    resolved = new URL(value.trim(), baseUrl);
  } catch {
    return '';
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return '';

  // Long enough for any real asset URL, short enough not to bloat a document.
  return resolved.toString().length > 2048 ? '' : resolved.toString();
}
