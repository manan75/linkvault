import { connectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { eventBus } from './events/index.js';
import { enrichmentWorker, metadataWorker, reaper } from './workers/runtime.js';

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
  app.listen(env.PORT, () => {
    console.log(`LinkVault API listening on http://localhost:${env.PORT}`);
  });

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

async function shutdown(signal) {
  console.log(`\n${signal} received, disconnecting…`);
  reaper.stop();
  await eventBus.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
