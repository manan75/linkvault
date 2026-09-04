import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiRouter } from './routes/index.js';

/**
 * Saving a bookmark is the only request that may be large, because it is the
 * only one that carries a page capture from the browser extension.
 *
 * Expressed as a choice between two parsers rather than as one raised limit.
 * Every other endpoint takes a handful of short fields, and a global increase
 * would hand anyone half a megabyte of parsing work on any of them -- including
 * the two that are reachable without a session. `POST /api/links` is behind
 * `requireAuth`, behind the per-account save limit and behind the link quota,
 * so the larger body is already three times bounded.
 *
 * It has to be decided here, before the router: the body is parsed on the way
 * in, so a per-route parser mounted inside `linkRouter` would never see a
 * request the global one had already rejected as too large.
 *
 * 512kb is sized against `MAX_CAPTURE_TEXT` -- 4KB of text is kept -- with room
 * for JSON escaping, the metadata fields, and an extension that trimmed less
 * aggressively than this server would.
 */
const STANDARD_BODY_LIMIT = '100kb';
const CAPTURE_BODY_LIMIT = '512kb';

function bodyParser() {
  const standard = express.json({ limit: STANDARD_BODY_LIMIT });
  const capture = express.json({ limit: CAPTURE_BODY_LIMIT });

  const isSaveLink = (req) => req.method === 'POST' && /^\/api\/links\/?$/.test(req.path);

  return (req, res, next) =>
    isSaveLink(req) ? capture(req, res, next) : standard(req, res, next);
}

/** Builds the Express app. Kept free of side effects so tests can mount it directly. */
export function createApp() {
  const app = express();

  // Render terminates TLS at its proxy and forwards the client address in
  // `X-Forwarded-For`. Without this, `req.secure` is false -- so `secure`
  // cookies would never be set -- and every request would appear to come from
  // the proxy, collapsing per-IP rate limiting onto a single shared bucket.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // This API is consumed from a different origin by design: the client is
      // served from Vercel and the API from Render. Helmet's default
      // `same-origin` resource policy is written for an app that serves its own
      // assets, which this one does not.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // In production the client is a different registrable domain, so this is the
  // only thing standing between the API and any page on the internet reading a
  // signed-in user's bookmarks. `origin` is an exact match, not a wildcard --
  // and it cannot be one, because `credentials: true` and `*` are mutually
  // exclusive by specification.
  app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
  app.use(bodyParser());
  app.use(cookieParser());

  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
