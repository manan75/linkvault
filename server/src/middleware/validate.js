import { ApiError } from '../utils/ApiError.js';

/**
 * Validates and replaces `req[source]` with the parsed result, so handlers
 * always receive data that has already passed the boundary check.
 */
export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      return next(ApiError.badRequest('Validation failed', details));
    }

    req[source] = result.data;
    return next();
  };
}
