import { createHash } from 'node:crypto';

import OpenAI from 'openai';

import { env } from '../config/env.js';
import { EmbeddingError } from './embeddingError.js';
import { classifyOpenAI } from './providerError.js';

/**
 * Turning a bookmark, and a question about one, into a vector.
 *
 * The only file in the project that knows how an embedding is produced -- the
 * same containment `enrichment.js` has, for the same reason. Everything above
 * it sees `embedLink`, `embedQuery` and `EmbeddingError`, so the runtime can
 * change without touching the worker, the queue or the search.
 *
 * ## Why a hosted API rather than Sentence Transformers
 *
 * `CLAUDE.md` names Sentence Transformers and a Python service, and this is a
 * deliberate departure from it, so per the Important Rule:
 *
 * **The problem.** Describing a half-remembered bookmark in your own words has
 * to find it. Keyword search cannot do this and no amount of index work makes
 * it: measured on a corpus containing exactly the right document, "make my
 * backend snappier" matched "Redis Caching Strategies" only via the shared word
 * "backend" in a tag. Remove every shared word and there is nothing to match.
 *
 * **Why the alternatives lost.** A Python + FastAPI service on Render is the
 * literal architecture in `CLAUDE.md`, and the free tier allows 750
 * instance-hours a month against a 730-hour month -- exactly one always-warm
 * service, which the API already is. A second one either costs money or cold
 * starts at 50 seconds. `transformers.js` in this process avoids that and is
 * genuinely the same model family, but onnxruntime plus weights is roughly
 * 250-350MB resident on a 512MB free instance that already runs the API and
 * three workers, and an OOM would only show up in production.
 *
 * **Why this one.** The OpenAI SDK, the key and the spending-ceiling machinery
 * are all here already, so this stage is the enrichment stage with a different
 * call in the middle. `text-embedding-3-small` is about $0.00002 per bookmark;
 * the whole per-user cap of 100 links costs a fifth of a cent.
 *
 * The cost of the choice, stated plainly: semantic search now needs a network
 * call to embed the query, and the vault cannot be searched by meaning while
 * the provider is down. Keyword search still works in that case, which is why
 * `services/search.js` degrades to it rather than failing.
 */

/**
 * How long one call may take before the SDK aborts it.
 *
 * As in `enrichment.js`, expressed as a request option rather than a race, so
 * the request is actually cancelled and the rejection is a correctly classified
 * `APIConnectionTimeoutError` rather than a plain `Error` the queue would read
 * as permanent. Much shorter than the enrichment deadline: this is one forward
 * pass over a few hundred tokens, not a generation.
 */
export const CALL_TIMEOUT_MS = 20_000;

/** A query is typed by a person who is waiting. It gets a tighter deadline. */
export const QUERY_TIMEOUT_MS = 8_000;

/** As in `enrichment.js`: the durable retry is ours, so the SDK's stays small. */
const SDK_MAX_RETRIES = 1;

/**
 * How much of a page's captured text to embed.
 *
 * `capture.text` can be a whole rendered page. Embedding all of it is both
 * expensive and worse: a single vector averaged over ten thousand words of
 * navigation, footer and comment thread says less about the page than one
 * built from its first few hundred. The opening of an article is also where it
 * says what it is about.
 */
const MAX_CAPTURE_CHARS = 2_000;

export { EmbeddingError };

/**
 * What gets embedded, and the answer to the question Phase 5 left open.
 *
 * `capture.text` has been stored and unread since the extension shipped. This
 * is what it was stored for. Three of four verification pages in Phase 5 had no
 * `og:description` and so got no summary -- for those links the title is nearly
 * all the keyword index has, and the captured text is the only description of
 * the page that exists anywhere in the system.
 *
 * Ordered most distinctive first, because it is also the order a truncation
 * would eat: title, then the summary written for exactly this purpose, then
 * tags, then the page's own words.
 *
 * `CLAUDE.md` is explicit that this represents "useful bookmark information
 * rather than the entire webpage", and the cap above is that sentence enforced.
 */
export function buildEmbeddingInput(link) {
  const capture = String(link.capture?.text ?? '')
    .trim()
    .slice(0, MAX_CAPTURE_CHARS);

  const parts = [
    link.title,
    link.summary,
    link.description,
    (link.tags ?? []).join(', '),
    link.author,
    link.domain,
    capture,
  ];

  return parts
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Whether there is anything worth embedding.
 *
 * A vector built from a domain name alone is not a description of anything: it
 * would sit in the same region of the space as every other bookmark from that
 * host and drag them all into every result. Not embedding is the honest answer,
 * and the link stays perfectly findable by keyword.
 */
export function hasEnoughToEmbed(input) {
  return input.trim().length >= 20;
}

/**
 * A fingerprint of the input, so an unchanged link is never embedded twice.
 *
 * The model is part of it. Vectors from two different models are not comparable
 * -- they are points in unrelated spaces -- so changing `EMBEDDING_MODEL` has
 * to invalidate every stored vector, and this is what makes the reaper notice
 * without a migration.
 */
export function embeddingFingerprint(input, model = env.EMBEDDING_MODEL) {
  return createHash('sha256').update(`${model}\n${input}`).digest('hex').slice(0, 32);
}

function classify(error) {
  if (error instanceof EmbeddingError) return error;

  return classifyOpenAI(error, {
    make: (message, options) => new EmbeddingError(message, options),
    subject: 'embedding model',
    onUnknown: (unknown) => new EmbeddingError(`Embedding failed: ${unknown.message}`),
  });
}

let client;

/** Lazily constructed, so importing this module never requires a key. */
function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: SDK_MAX_RETRIES });
  }
  return client;
}

/**
 * One vector for one piece of text.
 *
 * `dimensions` is passed explicitly rather than left to the model's default of
 * 1536. `text-embedding-3-small` is trained so that a prefix of its output is
 * itself a usable embedding, so asking for 512 costs a little accuracy and
 * three quarters of the storage -- and storage is the binding constraint on a
 * free Atlas tier, where 10,000 links at 1536 dimensions is roughly 120MB of
 * BSON doubles against a 512MB cap.
 *
 * Every vector in the collection must share this number, which is why the
 * fingerprint above includes the model and why changing either is a re-embed.
 */
async function embed(text, { timeoutMs }) {
  try {
    const response = await getClient().embeddings.create(
      {
        model: env.EMBEDDING_MODEL,
        input: text,
        dimensions: env.EMBEDDING_DIMENSIONS,
      },
      { timeout: timeoutMs },
    );

    const vector = response.data?.[0]?.embedding;

    // Permanent: a response shaped like this is not going to be shaped
    // differently on a retry of the same request.
    if (!Array.isArray(vector) || vector.length !== env.EMBEDDING_DIMENSIONS) {
      throw new EmbeddingError('The embedding model returned no usable vector');
    }

    return { vector, usage: response.usage };
  } catch (error) {
    throw classify(error);
  }
}

/** The vector for a bookmark, from `buildEmbeddingInput`. */
export function embedLink(input, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  return embed(input, { timeoutMs });
}

/**
 * The vector for a typed query.
 *
 * The same model and the same dimensions as the documents, which is not an
 * implementation detail but the entire premise: a query vector is only
 * meaningful in the space its documents were embedded into.
 */
export function embedQuery(query, { timeoutMs = QUERY_TIMEOUT_MS } = {}) {
  return embed(query.trim(), { timeoutMs });
}
