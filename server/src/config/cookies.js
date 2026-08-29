import { isProduction } from './env.js';

export const AUTH_COOKIE_NAME = 'linkvault_token';

/**
 * The session token lives in an httpOnly cookie so page scripts cannot read it,
 * which also gives logout a real server-side action: clear the cookie.
 */
export function authCookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    ...(maxAgeMs === undefined ? {} : { maxAge: maxAgeMs }),
  };
}

/** Cookie lifetime kept in step with the JWT lifetime. */
export const AUTH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
