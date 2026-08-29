import { verifyToken } from '../services/authService.js';
import { ApiError } from '../utils/ApiError.js';
import { AUTH_COOKIE_NAME } from '../config/cookies.js';

/**
 * Rejects unauthenticated requests and attaches `req.userId` for handlers.
 * Every route that touches user-owned data must sit behind this.
 */
export function requireAuth(req, res, next) {
  const token = req.cookies?.[AUTH_COOKIE_NAME];

  if (!token) {
    return next(ApiError.unauthorized());
  }

  try {
    req.userId = verifyToken(token);
    return next();
  } catch (error) {
    return next(error);
  }
}
