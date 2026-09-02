import { isProduction } from './env.js';

export const AUTH_COOKIE_NAME = 'linkvault_token';

/**
 * The session token lives in an httpOnly cookie so page scripts cannot read it,
 * which also gives logout a real server-side action: clear the cookie.
 *
 * `sameSite` differs by environment because the two environments have different
 * shapes. In development the Vite proxy makes every API call same-origin, so
 * `lax` is both correct and the safer default. In production the client is
 * served from Vercel and the API from Render -- two registrable domains, both
 * on the public suffix list, so there is no shared parent to fall back on and
 * the request is unavoidably cross-site. `lax` would silently drop the cookie:
 * login would appear to succeed and then not work.
 *
 * `none` is what makes a cross-site cookie legal, and browsers only accept it
 * alongside `secure`, which is why the two move together. The cost is that the
 * session becomes a third-party cookie, which Safari blocks outright -- v1 is
 * deliberately Chrome-first, and the Bearer-token path planned for after
 * Phase 6 is what removes the constraint rather than working around it.
 */
export function authCookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
    path: '/',
    ...(maxAgeMs === undefined ? {} : { maxAge: maxAgeMs }),
  };
}

/** Cookie lifetime kept in step with the JWT lifetime. */
export const AUTH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
