/**
 * What the extension reads off the page, and the only code that runs inside it.
 *
 * It reads the *rendered* DOM, which is the entire reason the extension exists.
 * `safeFetch` gets whatever the server is served: 429 from YouTube, 403 from
 * LeetCode, a login wall from Instagram, and an empty shell from anything that
 * renders in JavaScript. This runs in the tab the user is already looking at,
 * from their address and their session, so it sees the page they see.
 *
 * Nothing here decides what is safe. Everything it returns is untrusted input
 * that the API sanitises in `server/src/services/captureParser.js` -- the page
 * may be attacker-controlled, and the extension is not the boundary.
 *
 * **`readPage` must stay one self-contained function.**
 * `chrome.scripting.executeScript` serialises it and evaluates the source in
 * the page's world, so it closes over nothing: a constant hoisted to module
 * scope for tidiness would simply be `undefined` by the time it is read, in the
 * page rather than here, where no test would see it.
 */
export function readPage() {
  /** Roughly the first two screens, which is where a page says what it is about. */
  const MAX_TEXT = 4000;

  /**
   * Elements on every page and about none of it. Removing them before reading
   * text is most of the difference between an excerpt worth summarising and a
   * navigation menu.
   */
  const CHROME_SELECTOR =
    'script,style,noscript,template,svg,nav,header,footer,aside,form,iframe,' +
    '[role="navigation"],[role="banner"],[role="contentinfo"],[aria-hidden="true"]';

  /** Where an article's body actually lives, most specific first. */
  const CONTENT_SELECTORS = ['article', 'main', '[role="main"]', 'body'];

  const meta = (key) =>
    document.querySelector(`meta[property="${key}"]`)?.content ??
    document.querySelector(`meta[name="${key}"]`)?.content ??
    '';

  const firstOf = (...values) => values.find((value) => value && value.trim()) ?? '';

  const linkHref = (rel) => document.querySelector(`link[rel~="${rel}"]`)?.href ?? '';

  /**
   * The page's text with its furniture removed.
   *
   * Read from a clone, because the document belongs to the user: stripping
   * elements out of the live page to build an excerpt would visibly break the
   * thing they are reading.
   */
  const readText = () => {
    for (const selector of CONTENT_SELECTORS) {
      const source = document.querySelector(selector);
      if (!source) continue;

      const clone = source.cloneNode(true);
      clone.querySelectorAll(CHROME_SELECTOR).forEach((node) => node.remove());

      const text = (clone.innerText ?? clone.textContent ?? '')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      // A container that rendered almost nothing is worth falling through for.
      // `body` is last, so the walk always terminates.
      if (text.length > 200) return text.slice(0, MAX_TEXT);
    }

    return '';
  };

  return {
    title: firstOf(meta('og:title'), meta('twitter:title'), document.title),
    description: firstOf(meta('og:description'), meta('twitter:description'), meta('description')),
    author: firstOf(meta('author'), meta('article:author')),
    favicon: firstOf(linkHref('icon'), linkHref('apple-touch-icon'), '/favicon.ico'),
    thumbnail: firstOf(meta('og:image'), meta('twitter:image')),
    text: readText(),
  };
}
