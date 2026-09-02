import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiRouter } from './routes/index.js';

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
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
