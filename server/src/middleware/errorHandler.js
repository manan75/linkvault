import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';

export function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
export function errorHandler(error, req, res, next) {
  const isKnown = error instanceof ApiError;
  const statusCode = isKnown ? error.statusCode : 500;

  if (!isKnown && env.NODE_ENV !== 'test') {
    console.error('Unhandled error:', error);
  }

  res.status(statusCode).json({
    error: {
      message: isKnown ? error.message : 'Something went wrong',
      ...(isKnown && error.details ? { details: error.details } : {}),
    },
  });
}
