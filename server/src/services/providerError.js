import OpenAI from 'openai';

/**
 * A provider failure, already classified.
 *
 * Its own module so that the queues and the reaper can read `retryable` without
 * importing the service that raised it -- and therefore without dragging the
 * OpenAI SDK into the API process's import graph. The services stay the only
 * files that know a provider exists, which is what makes swapping one cheap.
 *
 * The same shape as `FetchError`, for the same reason: a queue decides between
 * another attempt and giving up by reading one boolean, and it should not have
 * to know a vendor error class to do it.
 */
export class ProviderError extends Error {
  constructor(message, { retryable = false, status } = {}) {
    super(message);
    this.name = new.target.name;
    this.retryable = retryable;
    this.status = status;
  }
}

/**
 * Translates an SDK error into the retryable/permanent split a queue needs.
 *
 * Ordered most specific first, because the SDK's error classes are a hierarchy
 * and a single broad `instanceof APIError` would swallow the distinction
 * between "the provider is briefly unwell" and "this request can never
 * succeed". Phase 3's third bug was a timeout misclassified as permanent; not
 * repeating it lives here.
 *
 * Shared by enrichment and embedding rather than written twice. The two call
 * different endpoints for different reasons, but an OpenAI 429 means the same
 * thing to both, and a second copy of this table is a second place for the
 * timeout bug to come back.
 *
 * @param make      Builds the caller's own error subclass, so the queue that
 *                  catches it still sees the type it expects.
 * @param subject   What to call the thing that failed, in a message shown to
 *                  nobody but the log.
 * @param onUnknown The fallback for an error that is not from the SDK at all --
 *                  a schema validation failure, or a bug in our own code.
 */
export function classifyOpenAI(error, { make, subject = 'model', onUnknown }) {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return make(`The ${subject} timed out`, { retryable: true });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return make(`Could not reach the ${subject}`, { retryable: true });
  }
  if (error instanceof OpenAI.RateLimitError) {
    return make(`Rate limited by the ${subject}`, { retryable: true, status: 429 });
  }
  if (error instanceof OpenAI.InternalServerError) {
    return make(`The ${subject} is unavailable`, { retryable: true, status: error.status });
  }
  // 400, 401, 403, 404 and anything else carrying a status: retrying an
  // identical request cannot change the answer.
  if (error instanceof OpenAI.APIError) {
    return make(`The ${subject} rejected the request (${error.status})`, { status: error.status });
  }

  return onUnknown(error);
}
