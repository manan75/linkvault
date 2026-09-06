import { ProviderError } from './providerError.js';

/**
 * An embedding failure, already classified.
 *
 * Separate from `EnrichmentError` because the two stages have separate state
 * machines and fail independently: a link whose summary could not be written
 * may still embed perfectly well from its title and tags, and a link that
 * summarised fine may fail to embed because the provider was busy.
 */
export class EmbeddingError extends ProviderError {}
