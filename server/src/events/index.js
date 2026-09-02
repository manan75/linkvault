import { env } from '../config/env.js';
import { createKafkaBus } from './kafkaBus.js';
import { createMemoryBus } from './memoryBus.js';

/**
 * The event bus the rest of the application talks to.
 *
 * Callers never learn which implementation they got. That is the whole point:
 * the reaper publishes and the worker subscribes identically whether there is a
 * broker or not, so `ENABLE_KAFKA` toggles durability and process boundaries
 * rather than selecting a different pipeline.
 */
export const eventBus = env.ENABLE_KAFKA
  ? createKafkaBus({ brokers: env.KAFKA_BROKERS, clientId: env.KAFKA_CLIENT_ID })
  : createMemoryBus();

export { TOPICS } from './topics.js';
