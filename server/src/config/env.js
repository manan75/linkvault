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
  OPENAI_MODEL: z.string().default('gpt-5-mini'),
  ENABLE_ENRICHMENT: z.enum(['true', 'false']).optional(),

  // Redis. Off means the in-memory rate limit store, which is sufficient while
  // there is exactly one API process -- see rateLimit/index.js for why the
  // seam exists before the implementation does.
  ENABLE_REDIS: z.enum(['true', 'false']).default('false'),
  REDIS_URL: z.string().min(1).optional(),

  // --- Spending bounds ---
  //
  // Registration is open, so a per-user cap is not by itself a bound: anyone
  // can create more users. These are two different instruments and both are
  // needed. The per-user cap shapes ordinary use; the daily ceiling is what
  // actually stands between a script and the OpenAI bill.
  MAX_LINKS_PER_USER: z.coerce.number().int().positive().default(100),
  ENRICHMENT_DAILY_LIMIT: z.coerce.number().int().nonnegative().default(200),

  // How long a shutdown may spend closing things before it stops waiting. Render
  // sends SIGKILL soon after SIGTERM, so this must expire well before that.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
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
  ENABLE_REDIS: parsed.data.ENABLE_REDIS === 'true',
};

export const isProduction = env.NODE_ENV === 'production';
