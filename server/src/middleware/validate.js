import { ApiError } from '../utils/ApiError.js';

/**
 * Express 5 exposes `req.query` through a getter with no setter, so the parsed
 * result has to be redefined onto the request rather than assigned.
 */
function replace(req, source, value) {
  if (source === 'query') {
    Object.defineProperty(req, 'query', { value, writable: true, configurable: true });
    return;
  }
  req[source] = value;
}

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

    replace(req, source, result.data);
    return next();
  };
}
