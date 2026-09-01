import { connectDatabase } from '../config/db.js';
import { env } from '../config/env.js';
import { eventBus } from '../events/index.js';
import { enrichmentWorker, metadataWorker } from './runtime.js';

/**
 * The worker process.
 *
 * This is the point of Phase 4: until extraction runs in a process that is not
 * the API, nothing has actually been decoupled. Scale this independently of the
 * API, restart it independently, and let it die without taking requests down.
 *
 * It does not run the reaper -- that lives with the API, on the producer side.
 */
async function start() {
  if (!env.ENABLE_KAFKA) {
    // The in-memory bus does not cross a process boundary, so a worker started
    // this way would sit idle forever while the API quietly processed
    // everything itself. Failing loudly beats looking healthy and doing nothing.
    console.error(
      'ENABLE_KAFKA is false, so the event bus is in-process and this worker would receive nothing.\n' +
        'Either start the broker (docker compose up -d kafka) and set ENABLE_KAFKA=true,\n' +
        'or drop this process — the API runs the pipeline itself when Kafka is off.',
    );
    process.exit(1);
  }

  await connectDatabase();
  console.log('Connected to MongoDB');

  // Unlike the API, this process has nothing else to do. Exiting non-zero lets
  // a supervisor restart it once the broker is back, which beats sitting idle
  // and looking healthy.
  await eventBus.start();
  console.log(`Connected to Kafka at ${env.KAFKA_BROKERS.join(', ')}`);

  await metadataWorker.start();
  console.log('Metadata worker consuming link.created');

  // Both consumers share this process. Splitting them is a scaling decision
  // with no evidence behind it yet, and the process boundary that mattered --
  // off the API -- is already crossed.
  if (env.ENABLE_ENRICHMENT) {
    await enrichmentWorker.start();
    console.log(`Enrichment worker consuming metadata.extracted using ${env.OPENAI_MODEL}`);
  } else {
    console.warn(
      env.OPENAI_API_KEY
        ? 'Enrichment disabled (ENABLE_ENRICHMENT=false) — no summaries or auto-tags'
        : 'Enrichment disabled: no OPENAI_API_KEY set — no summaries or auto-tags',
    );
  }
}

async function shutdown(signal) {
  console.log(`\n${signal} received, disconnecting…`);
  await eventBus.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((error) => {
  console.error('Failed to start the metadata worker:', error);
  process.exit(1);
});
