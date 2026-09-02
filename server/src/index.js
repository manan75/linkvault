import { connectDatabase, disconnectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { eventBus } from './events/index.js';
import { rateLimitStore } from './rateLimit/index.js';
import { createShutdown, listenForShutdown } from './utils/shutdown.js';
import { enrichmentWorker, metadataWorker, reaper } from './workers/runtime.js';

/** Held so shutdown can close it. Set once the server is listening. */
let httpServer = null;

async function start() {
  await connectDatabase();
  console.log('Connected to MongoDB');

  // Deliberately not fatal. The API serves bookmarks out of MongoDB and does
  // not need a broker to answer a single request; refusing to start because
  // Kafka is down would turn a background-processing outage into a total one.
  // The reaper keeps retrying, and links wait at `pending` until it recovers.
  try {
    await eventBus.start();
    console.log(
      env.ENABLE_KAFKA
        ? `Connected to Kafka at ${env.KAFKA_BROKERS.join(', ')}`
        : 'Kafka disabled — using the in-process event bus',
    );
  } catch (error) {
    console.warn(`Kafka unavailable (${error.message}). Serving without background processing.`);
  }

  const app = createApp();
  httpServer = app.listen(env.PORT, () => {
    console.log(`LinkVault API listening on http://localhost:${env.PORT}`);
  });

  // Expires the windows of addresses that have gone quiet. Without it the store
  // grows by one entry per unique IP and never shrinks.
  rateLimitStore.start();

  // Started after the server is up: this is background work and must never
  // delay the API becoming available.
  if (env.ENABLE_METADATA_WORKER) {
    reaper.start();
    console.log('Reaper publishing link.created');

    // With a broker, extraction belongs to its own process (npm run worker).
    // Without one, the bus does not cross a process boundary, so the consumer
    // has to live here or nothing would ever consume.
    if (!env.ENABLE_KAFKA) {
      await metadataWorker.start();
      console.log('Metadata worker running in-process');
    }

    logEnrichmentState();

    if (env.ENABLE_ENRICHMENT && !env.ENABLE_KAFKA) {
      await enrichmentWorker.start();
      console.log('Enrichment worker running in-process');
    }
  }
}

/**
 * Says out loud why enrichment is or is not running.
 *
 * Without this the failure mode is silent and baffling: every link arrives
 * `ready` with no summary and no tags, nothing is logged, and the only clue is
 * a variable that was never set. A missing key is by far the likeliest cause,
 * so it gets its own line rather than being folded into a generic "disabled".
 */
function logEnrichmentState() {
  if (env.ENABLE_ENRICHMENT) {
    console.log(`Enrichment enabled using ${env.OPENAI_MODEL}`);
    return;
  }

  console.log(
    env.OPENAI_API_KEY
      ? 'Enrichment disabled (ENABLE_ENRICHMENT=false) — links will have no summary or auto-tags'
      : 'Enrichment disabled: no OPENAI_API_KEY set — links will have no summary or auto-tags',
  );
}

/** Resolves once the HTTP server has stopped, or immediately if it never started. */
function closeHttpServer() {
  if (!httpServer) return Promise.resolve();

  return new Promise((resolve) => {
    httpServer.close(() => resolve());

    // `close` stops accepting new connections but waits for open ones to end,
    // and a keep-alive connection sitting idle will happily wait out its own
    // timeout. Without this, one idle browser tab is enough to make every
    // shutdown run to the backstop.
    httpServer.closeIdleConnections?.();
  });
}

/**
 * Stops everything in an order that does not strand work.
 *
 * This runs on **every deploy**, not only on the rare crash: Render sends
 * SIGTERM to the old process each time a new one is released, so anything
 * wrong here is wrong routinely rather than exceptionally. It used to stop the
 * reaper and the bus and exit immediately, which severed in-flight requests,
 * left MongoDB connected, and never stopped either worker -- so a link being
 * fetched or summarised at that moment kept its claim and had to wait for the
 * stale-lease sweep to rescue it.
 *
 * The order is the argument:
 *
 * 1. **Reaper first.** It is the only producer, so the backlog stops growing
 *    while everything else winds down.
 * 2. **HTTP next.** Stop accepting requests, but let the ones already in
 *    flight answer -- Render has stopped routing new traffic here by now.
 * 3. **Workers.** They decline new messages and finish what they hold, which
 *    is the difference between a claim released cleanly and one abandoned.
 * 4. **Bus, then MongoDB last**, because everything above it writes to it.
 */
const shutdown = createShutdown({
  timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  steps: [
    () => reaper.stop(),
    () => rateLimitStore.stop(),
    () => closeHttpServer(),
    // Settled rather than all: one worker refusing to drain must not deny the
    // other its chance to finish.
    () => Promise.allSettled([metadataWorker.stop(), enrichmentWorker.stop()]),
    () => eventBus.stop(),
    () => disconnectDatabase(),
  ],
});

listenForShutdown(shutdown);

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
