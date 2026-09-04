import { Router } from 'express';

import {
  createToken,
  createTokenSchema,
  deleteToken,
  getTokens,
  login,
  loginSchema,
  logout,
  me,
  register,
  registerSchema,
} from '../controllers/authController.js';
import { byIp, byUser, createRateLimit, MINUTE_MS } from '../middleware/rateLimit.js';
import { requireAuth, requireSession } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';

export const authRouter = Router();

/**
 * Both limits are per IP, which is the only identifier that exists before a
 * session does. It is crude -- an office behind one NAT shares a budget -- but
 * the alternative to a crude limit here is no limit at all.
 */

/** Brute-force protection. Ten wrong passwords in a quarter of an hour is
 * already far more than a person mistyping, and far less than a script. */
const loginLimiter = createRateLimit({
  name: 'login',
  limit: 10,
  windowMs: 15 * MINUTE_MS,
  keyBy: byIp,
  message: 'Too many sign-in attempts. Try again in a few minutes.',
});

/**
 * Tighter than login, and deliberately so. Registration is open, which makes
 * account creation the way past every per-user quota in the system: the link
 * cap and the enrichment ceiling both assume accounts are not free to mint by
 * the thousand. Five an hour is invisible to a real person and ruinous to a
 * script.
 */
const registerLimiter = createRateLimit({
  name: 'register',
  limit: 5,
  windowMs: 60 * MINUTE_MS,
  keyBy: byIp,
  message: 'Too many accounts created from this address. Try again later.',
});

/**
 * Per account, not per address, because the person creating tokens is signed in
 * and the resource being protected is rows in their name.
 *
 * Set deliberately above `MAX_TOKENS_PER_USER`, so the cap is what a real user
 * meets and this only catches a loop. Below it, someone revoking and reissuing
 * a token would be told to wait when what they actually needed to hear is that
 * they already have too many.
 */
const tokenLimiter = createRateLimit({
  name: 'create-token',
  limit: 20,
  windowMs: 60 * MINUTE_MS,
  keyBy: byUser,
  message: 'Too many access tokens created. Try again in a little while.',
});

authRouter.post('/register', registerLimiter, validate(registerSchema), register);
authRouter.post('/login', loginLimiter, validate(loginSchema), login);
authRouter.post('/logout', logout);
authRouter.get('/me', requireAuth, me);

/**
 * Token management is `requireSession`, not `requireAuth`: a token must never
 * be able to mint its own replacement. Everything else in the API accepts
 * either credential.
 */
authRouter.post(
  '/tokens',
  requireAuth,
  requireSession,
  tokenLimiter,
  validate(createTokenSchema),
  createToken,
);
authRouter.get('/tokens', requireAuth, requireSession, getTokens);
authRouter.delete('/tokens/:id', requireAuth, requireSession, deleteToken);
