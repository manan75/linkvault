import { z } from 'zod';

import {
  AUTH_COOKIE_MAX_AGE_MS,
  AUTH_COOKIE_NAME,
  authCookieOptions,
} from '../config/cookies.js';
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
