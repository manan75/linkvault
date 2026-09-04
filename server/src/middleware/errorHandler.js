import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';

export function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

/**
 * Errors raised by the body parser before any handler runs.
 *
 * They arrive as plain `Error`s carrying a `type`, so without this they would
 * be reported as 500s -- telling a client that sent too much data that the
 * server is broken, and burying the one thing it could act on. Both are the
 * request's fault and both are safe to describe.
 */
function fromBodyParser(error) {
  if (error?.type === 'entity.too.large') {
    return new ApiError(413, 'That request body is too large');
  }
  if (error?.type === 'entity.parse.failed') {
    return ApiError.badRequest('That request body is not valid JSON');
  }

  return null;
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
export function errorHandler(rawError, req, res, next) {
  const error = rawError instanceof ApiError ? rawError : fromBodyParser(rawError) ?? rawError;

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
