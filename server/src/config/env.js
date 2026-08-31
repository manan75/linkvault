import { z } from 'zod';

/**
 * Environment is validated once at startup so a misconfigured deployment fails
 * immediately and loudly rather than at the first request that needs a value.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  // The in-process metadata poller. Left unset it follows the environment: on
  // everywhere except tests, where a background loop racing the assertions
  // would make the suite non-deterministic.
  ENABLE_METADATA_WORKER: z.enum(['true', 'false']).optional(),

  // Kafka. Off means the in-memory bus, which keeps the whole pipeline working
  // in a single process with no broker -- see events/memoryBus.js.
  ENABLE_KAFKA: z.enum(['true', 'false']).default('false'),
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().default('linkvault'),

  // Enrichment (Phase 5). The key is optional on purpose: without one the
  // enrichment worker disables itself and every other stage keeps working, so
  // a fresh clone runs the whole product without an OpenAI account. Startup
  // says so out loud rather than leaving links silently un-enriched.
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().default('gpt-5.6-luna'),
  ENABLE_ENRICHMENT: z.enum(['true', 'false']).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = {
  ...parsed.data,
  ENABLE_METADATA_WORKER:
    (parsed.data.ENABLE_METADATA_WORKER ?? String(parsed.data.NODE_ENV !== 'test')) === 'true',
  ENABLE_KAFKA: parsed.data.ENABLE_KAFKA === 'true',
  KAFKA_BROKERS: parsed.data.KAFKA_BROKERS.split(',').map((broker) => broker.trim()),
  // Follows the environment like the metadata worker, but a missing key vetoes
  // it either way -- there is nothing to call.
  ENABLE_ENRICHMENT:
    (parsed.data.ENABLE_ENRICHMENT ?? String(parsed.data.NODE_ENV !== 'test')) === 'true' &&
    Boolean(parsed.data.OPENAI_API_KEY),
};

export const isProduction = env.NODE_ENV === 'production';
