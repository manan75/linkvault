import { env } from '../config/env.js';
import { createMemoryRateLimitStore } from './memoryStore.js';

/**
 * The rate limit store the middleware talks to, chosen the way `events/index.js`
 * chooses a bus: callers never learn which implementation they got.
 *
 * The seam exists before the Redis implementation does, and that is deliberate
 * rather than speculative. `CLAUDE.md` warns against adding Redis for its own
 * sake, and on a single free instance an in-memory counter is genuinely
 * sufficient -- there is one process, and there is no search to cache yet.
 * What the seam buys is that Phase 7's cache and its processing deduplication
 * both need a client, and they will find one behind an interface instead of
 * reaching for a new dependency mid-phase.
 *
 * `ENABLE_REDIS=true` fails loudly rather than silently falling back, matching
 * the rest of this file's philosophy: a misconfigured deployment should stop at
 * startup, not discover at the first request that its limits are not shared.
 */
function selectStore() {
  if (!env.ENABLE_REDIS) return createMemoryRateLimitStore();

  throw new Error(
    'ENABLE_REDIS=true, but the Redis rate limit store is not implemented yet (planned for Phase 7). ' +
      'Set ENABLE_REDIS=false to use the in-memory store.',
  );
}

export const rateLimitStore = selectStore();
