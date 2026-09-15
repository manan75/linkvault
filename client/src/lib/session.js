/*
  A hint about whether this browser has ever been signed in.

  The session itself lives in an httpOnly cookie, which JavaScript deliberately
  cannot read -- so the only way to learn who you are is to ask the API, and
  that answer can take 20+ seconds when the free instance is cold.

  That is fine for the dashboard, which genuinely cannot be drawn without it.
  It is wrong for the landing page: a first-time visitor has no session to wait
  for, and making them watch a spinner before they are told what the product
  even is defeats the point of having the page.

  So this records only the fact that a session once existed here. It is not a
  credential, it grants nothing, and forging it buys an attacker a spinner. The
  cookie remains the only thing the server trusts.
*/

const KEY = 'linkvault.hasSession';

/**
 * Storage can throw rather than return null -- a private window, blocked site
 * data. Every caller of this treats "unknown" as "no session", which is the
 * safe direction: the worst case is a returning user seeing the landing page
 * for the moment it takes the real check to finish.
 */
export function hasSessionHint() {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setSessionHint(exists) {
  try {
    if (exists) window.localStorage.setItem(KEY, '1');
    else window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do. The app works without the hint; it is only ever an
    // optimisation about what to paint first.
  }
}
