import { AUTH_COOKIE_NAME } from '../config/cookies.js';
import { looksLikeApiToken, redeemApiToken } from '../services/apiTokenService.js';
import { verifyToken } from '../services/authService.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Rejects unauthenticated requests and attaches `req.userId` for handlers.
 * Every route that touches user-owned data must sit behind this.
 *
 * Two credentials are accepted, and which one was used is recorded on
 * `req.authMethod`:
 *
 * - `session` -- the httpOnly cookie the web app gets at sign-in.
 * - `token` -- an `Authorization: Bearer lv_...` credential, for clients that
 *   cannot hold a cookie. The browser extension is the reason it exists; its
 *   popup runs on `chrome-extension://`, which is cross-site to the API.
 *
 * The cookie is checked first so the web app's behaviour is exactly what it was
 * before tokens existed. The distinction is not decoration: `requireSession`
 * below uses it to keep a token from minting another token.
 */
export const requireAuth = asyncHandler(async (req, res, next) => {
  const cookie = req.cookies?.[AUTH_COOKIE_NAME];

  if (cookie) {
    req.userId = verifyToken(cookie);
    req.authMethod = 'session';
    return next();
  }

  const header = req.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  // Only opaque tokens are accepted here. A session JWT presented as a bearer
  // credential is refused rather than honoured: the cookie is the only place
  // the web app's session is meant to live, and accepting it from a header
  // would hand any script that can read it a working credential.
  if (looksLikeApiToken(bearer)) {
    req.userId = await redeemApiToken(bearer);
    req.authMethod = 'token';
    return next();
  }

  throw ApiError.unauthorized();
});

/**
 * Narrows `requireAuth` to a real browser session.
 *
 * Mounted on token management, so a stolen extension token cannot quietly mint
 * a replacement for itself and survive the revocation of the one that leaked.
 * Escalation from one credential to a stronger one is the thing being refused.
 */
export function requireSession(req, res, next) {
  if (req.authMethod !== 'session') {
    return next(ApiError.forbidden('Sign in on the web app to manage access tokens'));
  }

  return next();
}
