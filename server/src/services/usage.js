import { DailyUsage } from '../models/DailyUsage.js';
import { env } from '../config/env.js';
import { Link } from '../models/Link.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * The two bounds on what this deployment can cost.
 *
 * Registration is open, so these are not the same instrument wearing two hats.
 * A per-user cap shapes ordinary use and stops one enthusiastic account filling
 * the free Atlas tier, but it bounds nothing against an attacker, who can
 * simply register again. The daily ceiling is the actual bound: it is global, it
 * does not care how many accounts exist, and it is what stands between a script
 * and the OpenAI bill.
 *
 * Both live in MongoDB. See `models/DailyUsage.js` for why that is not an
 * arbitrary choice.
 */

/** UTC, deliberately: a ceiling that rolls over at a server's local midnight is
 * a ceiling whose reset time nobody can predict from the outside. */
export function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Reserves one unit of the day's enrichment budget.
 *
 * The conditional upsert is the whole mechanism: the filter refuses to match a
 * counter already at the limit, so the increment either happens or does not,
 * atomically, with no read-then-write window for two workers to race through.
 * When the filter matches nothing **and** the document already exists, the
 * upsert collides with the primary key and Mongo raises 11000 -- which is not
 * an error here, it is the answer. That is the budget being exhausted.
 */
export async function reserveEnrichment({ limit = env.ENRICHMENT_DAILY_LIMIT, now = new Date() } = {}) {
  const day = dayKey(now);

  if (limit <= 0) return { allowed: false, count: 0, limit, day };

  try {
    const usage = await DailyUsage.findOneAndUpdate(
      { _id: `enrichment:${day}`, count: { $lt: limit } },
      { $inc: { count: 1 }, $setOnInsert: { day } },
      { upsert: true, new: true },
    );

    return { allowed: true, count: usage.count, limit, day };
  } catch (error) {
    if (error?.code === 11000) return { allowed: false, count: limit, limit, day };
    throw error;
  }
}

/**
 * Reads the day's spend without reserving any of it.
 *
 * Used by the reaper to stop feeding work into a pipeline that cannot pay for
 * it. Without that, an exhausted budget would not stop anything -- it would
 * just move the refusal one stage later, and every link awaiting enrichment
 * would cycle through claim, refuse and release on every lease expiry, burning
 * database writes to discover the same answer repeatedly.
 */
export async function enrichmentUsage({ limit = env.ENRICHMENT_DAILY_LIMIT, now = new Date() } = {}) {
  const day = dayKey(now);
  const usage = await DailyUsage.findById(`enrichment:${day}`);
  const count = usage?.count ?? 0;

  return { count, limit, remaining: Math.max(0, limit - count), exhausted: count >= limit, day };
}

/**
 * Throws unless the user has room for one more bookmark.
 *
 * Counts rather than caching, because the number has to be right at the moment
 * of the write and a stale count is how a cap gets walked past. `countDocuments`
 * on an indexed `userId` at these volumes is not worth optimising away.
 */
export async function assertLinkQuota(userId, { limit = env.MAX_LINKS_PER_USER } = {}) {
  const saved = await Link.countDocuments({ userId });

  if (saved >= limit) {
    throw ApiError.forbidden(
      `You have reached the ${limit} bookmark limit for this account. Delete a bookmark to save a new one.`,
    );
  }

  return { saved, limit };
}
