import { Router } from 'express';

import { login, loginSchema, logout, me, register, registerSchema } from '../controllers/authController.js';
import { byIp, createRateLimit, MINUTE_MS } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
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

authRouter.post('/register', registerLimiter, validate(registerSchema), register);
authRouter.post('/login', loginLimiter, validate(loginSchema), login);
authRouter.post('/logout', logout);
authRouter.get('/me', requireAuth, me);
