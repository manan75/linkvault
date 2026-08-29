import { ApiRequestError } from './api';

/**
 * Splits an API failure into per-field messages and a single form-level message,
 * so both auth forms report validation errors the same way.
 */
export function toFormErrors(error) {
  if (!(error instanceof ApiRequestError)) {
    return { fieldErrors: {}, formError: 'Something went wrong. Please try again.' };
  }

  const fieldErrors = Object.fromEntries(
    error.details.map((detail) => [detail.field, detail.message]),
  );

  const hasFieldErrors = Object.keys(fieldErrors).length > 0;

  return { fieldErrors, formError: hasFieldErrors ? null : error.message };
}
