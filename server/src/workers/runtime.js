import { eventBus } from '../events/index.js';
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
 * there is not.
 */
export const reaper = createReaper({ bus: eventBus });

export const metadataWorker = createMetadataWorker({ bus: eventBus });
