import { Router } from 'express';
import mongoose from 'mongoose';

import { asyncHandler } from '../utils/asyncHandler.js';
import { withDeadline } from '../utils/withDeadline.js';

/**
 * Two health endpoints, deliberately, because they answer different questions
 * and must not be allowed to answer each other's.
 *
 * `/health` says the process is listening. That is all it says, and it is
 * exactly what the free-tier keep-warm ping needs: Render spins a service down
 * after ~15 idle minutes and takes ~50 seconds to wake, so something external
 * hits this every few minutes purely to be inbound traffic. It touches nothing,
 * so it can never be the reason a deploy is marked unhealthy.
 *
 * `/health/deep` says the app can actually do its job, which today means
 * MongoDB answers. It returns 503 when it cannot -- and that is precisely why
 * it is a separate path. A platform health check pointed at an endpoint that
 * goes 503 during an Atlas blip will restart the service, repeatedly, on top of
 * an outage it cannot fix by restarting. Point uptime monitoring here; point
 * the platform, and the keep-warm ping, at `/health`.
 */

export const healthRouter = Router();

/**
 * How long the database gets to answer before it is called down.
 *
 * Short on purpose. The failure this exists to catch is a connection that hangs
 * rather than refuses -- an unreachable Atlas, a network partition, a paused
 * cluster -- and against that, a check with no deadline of its own hangs too,
 * turning the thing that reports outages into a second outage.
 */
const PING_TIMEOUT_MS = 3_000;

/**
 * How long an answer is reused.
 *
 * This endpoint is unauthenticated, which means anyone can ask it. Without the
 * cache each request would become a database round trip and the health check
 * would be a small amplifier pointed at the database it is meant to protect.
 * Five seconds bounds that to at most twelve pings a minute however hard it is
 * hit, and is far finer than any monitor's interval.
 */
const CACHE_MS = 5_000;

const STATES = ['disconnected', 'connected', 'connecting', 'disconnecting', 'uninitialized'];

let cached = null;

async function pingDatabase() {
  // 1 is `connected`. Anything else means mongoose is not in a state where a
  // command would mean much, and it is worth reporting as itself rather than
  // waiting out the timeout to learn the same thing.
  if (mongoose.connection.readyState !== 1) {
    return { ok: false, detail: STATES[mongoose.connection.readyState] ?? 'unknown' };
  }

  try {
    await withDeadline(
      mongoose.connection.db.admin().ping(),
      PING_TIMEOUT_MS,
      'the database did not answer in time',
    );

    return { ok: true, detail: 'connected' };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

/** The keep-warm ping. Deliberately incapable of failing for any other reason. */
healthRouter.get('/', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

healthRouter.get(
  '/deep',
  asyncHandler(async (req, res) => {
    if (!cached || Date.now() - cached.at > CACHE_MS) {
      cached = { at: Date.now(), database: await pingDatabase() };
    }

    const { database } = cached;

    res.status(database.ok ? 200 : 503).json({
      status: database.ok ? 'ok' : 'degraded',
      checks: { database },
    });
  }),
);

/** Test seam: the cache would otherwise carry a verdict between assertions. */
export function resetHealthCache() {
  cached = null;
}
