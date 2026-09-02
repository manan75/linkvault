/**
 * A provider failure, already classified.
 *
 * Its own module so that the queue and the reaper can read `retryable` without
 * importing `enrichment.js` -- and therefore without dragging the OpenAI SDK
 * into the API process's import graph. `enrichment.js` stays the only file that
 * knows a provider exists, which is what makes swapping one cheap.
 *
 * The same shape as `FetchError`, for the same reason: the queue decides
 * between another attempt and giving up by reading one boolean, and it should
 * not have to know a vendor error class to do it.
 */
export class EnrichmentError extends Error {
  constructor(message, { retryable = false, status } = {}) {
    super(message);
    this.name = 'EnrichmentError';
    this.retryable = retryable;
    this.status = status;
  }
}
