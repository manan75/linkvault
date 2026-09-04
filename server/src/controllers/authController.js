import { z } from 'zod';

import {
  AUTH_COOKIE_MAX_AGE_MS,
  AUTH_COOKIE_NAME,
  authCookieOptions,
} from '../config/cookies.js';
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from '../services/apiTokenService.js';
import {
  authenticateUser,
  findUserById,
  issueToken,
  registerUser,
} from '../services/authService.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(200, 'Password must be at most 200 characters'),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const createTokenSchema = z.object({
  // Named by the user, because the only thing revocation needs is for them to
  // be able to tell one client from another.
  name: z.string().trim().min(1, 'Give this token a name').max(60),
});

function startSession(res, user) {
  res.cookie(AUTH_COOKIE_NAME, issueToken(user), authCookieOptions(AUTH_COOKIE_MAX_AGE_MS));
}

export const register = asyncHandler(async (req, res) => {
  const user = await registerUser(req.body);
  startSession(res, user);
  res.status(201).json({ user: user.toPublicJSON() });
});

export const login = asyncHandler(async (req, res) => {
  const user = await authenticateUser(req.body);
  startSession(res, user);
  res.status(200).json({ user: user.toPublicJSON() });
});

export const logout = asyncHandler(async (req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, authCookieOptions());
  res.status(204).end();
});

export const me = asyncHandler(async (req, res) => {
  const user = await findUserById(req.userId);

  // The token was valid but the account is gone (e.g. deleted since sign-in).
  if (!user) throw ApiError.unauthorized('Session is no longer valid');

  res.status(200).json({ user: user.toPublicJSON() });
});

/**
 * Mints an access token and returns it in the clear.
 *
 * This is the only response in the system that ever carries the token: nothing
 * stored can reproduce it, so a client that loses it creates a new one. The
 * shape says so -- `token` sits beside the record rather than inside it,
 * because every later read of that record returns the record alone.
 */
export const createToken = asyncHandler(async (req, res) => {
  const { token, apiToken } = await createApiToken({
    userId: req.userId,
    name: req.body.name,
  });

  res.status(201).json({ token, apiToken: apiToken.toPublicJSON() });
});

export const getTokens = asyncHandler(async (req, res) => {
  const tokens = await listApiTokens(req.userId);
  res.status(200).json({ tokens: tokens.map((token) => token.toPublicJSON()) });
});

export const deleteToken = asyncHandler(async (req, res) => {
  await revokeApiToken({ userId: req.userId, id: req.params.id });
  res.status(204).end();
});
