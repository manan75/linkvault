import { env } from '../config/env.js';
import { eventBus } from '../events/index.js';
import { enrichmentUsage } from '../services/usage.js';
import { createEnrichmentWorker } from './enrichmentWorker.js';
import { createMetadataWorker } from './metadataWorker.js';
import { createReaper } from './reaper.js';

/**
 * The singletons the two entrypoints and the API share.
 *
 * The reaper lives on the **producer** side, in the API process. It reads
 * MongoDB and publishes, which is the API's half of the pipeline, and it means
 * `saveLink` can nudge it in-process rather than needing a way to poke another
 * machine. The metadata worker is a pure consumer and runs wherever it is
 * started -- its own process when there is a broker, alongside the API when
 * there is not. The enrichment worker is the same kind of thing, one stage
 * further along.
 */
export const reaper = createReaper({
  bus: eventBus,
  // Nothing consumes the republished event when there is no key, so sweeping
  // for it would cycle every link in the library through the queued lease and
  // back for no reason.
  enrichmentEnabled: env.ENABLE_ENRICHMENT,
  // Stops the sweep publishing enrichment work the daily ceiling will refuse
  // to pay for. The worker enforces the ceiling; this keeps a spent budget from
  // turning into a night of pointless database churn.
  hasEnrichmentBudget: async () => !(await enrichmentUsage()).exhausted,
});

export const metadataWorker = createMetadataWorker({ bus: eventBus });

export const enrichmentWorker = createEnrichmentWorker({ bus: eventBus });
