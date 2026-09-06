import { ProviderError } from './providerError.js';

/**
 * A summarisation failure, already classified.
 *
 * Distinct from `EmbeddingError` even though both are `ProviderError`s and both
 * come from the same vendor, because the two stages fail independently and the
 * queues that catch them are separate state machines. A link whose summary
 * could not be written may still embed perfectly well.
 */
export class EnrichmentError extends ProviderError {}
