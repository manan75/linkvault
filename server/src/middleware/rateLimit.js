import { rateLimitStore } from '../rateLimit/index.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/** Windows, in one place, so the numbers are readable next to each other. */
export const MINUTE_MS = 60_000;

/**
 * Builds a fixed-window rate limiter.
 *
 * `keyBy` decides what is being limited, and choosing it is the whole design.
 * Anonymous endpoints have nothing but the address, so they are limited per IP,
 * which is crude -- one office behind one NAT shares a budget -- but it is the
 * only identifier that exists before a session does. Anything that spends money
 * is limited per **user** instead, because the resource is billed per account
 * and an attacker with one account and many addresses would otherwise walk
 * straight past an IP limit.
 *
 * A limiter returning no key is skipped rather than failing closed. The only
 * way that happens is a misconfiguration -- a per-user limiter mounted ahead of
 * `requireAuth` -- and locking every user out of an endpoint is a worse
 * response to that than letting the request through and leaving the route
 * unprotected until someone notices.
 */
export function createRateLimit({
  name,
  limit,
  windowMs,
  keyBy,
  message = 'Too many requests. Try again shortly.',
  store = rateLimitStore,
}) {
  return asyncHandler(async (req, res, next) => {
    const subject = keyBy(req);
    if (!subject) return next();

    const { count, resetAt } = await store.hit(`${name}:${subject}`, windowMs);
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));

    // The IETF draft header names, which is what clients and proxies read.
    res.setHeader('RateLimit-Limit', limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, limit - count));
    res.setHeader('RateLimit-Reset', retryAfterSeconds);

    if (count > limit) {
      res.setHeader('Retry-After', retryAfterSeconds);
      throw ApiError.tooManyRequests(message);
    }

    return next();
  });
}

/** Keyed by address. `trust proxy` is set in app.js, so this is the real client. */
export const byIp = (req) => req.ip;

/** Keyed by account. Only valid behind `requireAuth`. */
export const byUser = (req) => req.userId ?? null;
