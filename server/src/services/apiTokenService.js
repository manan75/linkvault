import crypto from 'node:crypto';

import { ApiToken } from '../models/ApiToken.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Issuing, redeeming and revoking the tokens non-browser clients authenticate
 * with.
 *
 * Kept apart from `authService.js` because the two credentials answer different
 * questions. A session proves a person is at a keyboard right now and expires
 * accordingly; a token proves a program was once authorised by that person and
 * is meant to keep working until it is revoked.
 */

/**
 * A recognisable prefix, so a leaked token is identifiable on sight -- by a
 * secret scanner, by a reviewer reading a log, and by the user pasting it into
 * the wrong box. It is part of the token and is hashed with the rest.
 */
const TOKEN_PREFIX = 'lv_';

/** 32 bytes from a CSPRNG: unguessable, and short enough to paste. */
const TOKEN_BYTES = 32;

/**
 * More than anyone needs, few enough that a script cannot use token creation as
 * a way to fill the database.
 */
export const MAX_TOKENS_PER_USER = 10;

/** How stale `lastUsedAt` is allowed to get before a request pays to refresh it. */
const LAST_USED_RESOLUTION_MS = 24 * 60 * 60 * 1000;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Whether a string is even shaped like one of ours, before touching the database. */
export const looksLikeApiToken = (value) =>
  typeof value === 'string' && value.startsWith(TOKEN_PREFIX);

/**
 * Mints a token for a user and returns it in the clear, once.
 *
 * The caller is responsible for showing it to the user immediately: nothing
 * stored here can reproduce it.
 */
export async function createApiToken({ userId, name }) {
  const count = await ApiToken.countDocuments({ userId });

  if (count >= MAX_TOKENS_PER_USER) {
    throw ApiError.conflict(
      `You already have ${MAX_TOKENS_PER_USER} access tokens. Revoke one before creating another.`,
    );
  }

  const token = TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('base64url');

  const record = await ApiToken.create({ userId, name, tokenHash: hashToken(token) });

  return { token, apiToken: record };
}

/**
 * Returns the user id a token belongs to, or throws 401.
 *
 * Timing is not a concern here the way it is for a password: the lookup is an
 * indexed match on a hash of a 256-bit random value, so there is no adjacent
 * guess for a timing signal to help refine.
 */
export async function redeemApiToken(token) {
  const record = await ApiToken.findOne({ tokenHash: hashToken(token) });

  if (!record) throw ApiError.unauthorized('Invalid access token');

  await touch(record);

  return record.userId.toString();
}

/**
 * Records that the token was used, at most once a day.
 *
 * Deliberately not awaited by the caller's critical path in spirit -- but it is
 * awaited here, because an unawaited write would be a floating promise the
 * shutdown path cannot see. Skipping it on all but one request a day is what
 * keeps that cheap.
 */
async function touch(record) {
  const now = Date.now();

  if (record.lastUsedAt && now - record.lastUsedAt.getTime() < LAST_USED_RESOLUTION_MS) return;

  await ApiToken.updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date(now) } });
}

export async function listApiTokens(userId) {
  return ApiToken.find({ userId }).sort({ createdAt: -1 });
}

/** Revocation is immediate: the next request carrying this token gets a 401. */
export async function revokeApiToken({ userId, id }) {
  const result = await ApiToken.deleteOne({ _id: id, userId });

  // Scoped by `userId`, so a token belonging to somebody else is indistinguishable
  // from one that does not exist -- which is the point.
  if (result.deletedCount === 0) throw ApiError.notFound('Access token not found');
}
