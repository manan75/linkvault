/**
 * The first http(s) URL in some pasted text, or null.
 *
 * Pasted text is rarely only a URL. It arrives with a trailing newline from a
 * terminal, wrapped in punctuation from a chat message, with a word of context
 * in front of it, or as a whole sentence someone happened to have copied.
 * Anything that is not a web address is refused here rather than sent to the
 * server to be rejected there, because the answer arrives instantly and without
 * spending a cold start to hear it.
 *
 * Kept apart from the popup so it can be read and tested without a browser.
 */
export function urlFromText(text) {
  if (!text) return null;

  for (const candidate of String(text).trim().split(/\s+/)) {
    // Strip the punctuation a link collects when it is quoted or pasted into
    // prose. Leading and trailing only: everything in between may be path.
    const trimmed = candidate.replace(/^[<("'[]+/, '').replace(/[>)"'\].,;!?]+$/, '');

    try {
      const url = new URL(trimmed);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {
      // Not a URL. Try the next word.
    }
  }

  return null;
}
