import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { clearTestDatabase, startTestDatabase, stopTestDatabase } from './helpers.js';

const { Link } = await import('../src/models/Link.js');
const { createMemoryBus } = await import('../src/events/memoryBus.js');
const { TOPICS } = await import('../src/events/topics.js');
const { createReaper } = await import('../src/workers/reaper.js');
const { createEmbeddingWorker } = await import('../src/workers/embeddingWorker.js');
const {
  EMBEDDING_PROCESSING_LEASE_MS,
  EMBEDDING_QUEUED_LEASE_MS,
  EMBEDDING_QUEUE_GRACE_MS,
  MAX_EMBEDDING_ATTEMPTS,
  reclaimStaleEmbedding,
} = await import('../src/workers/embeddingQueue.js');
const { EmbeddingError } = await import('../src/services/embeddingError.js');
const { buildEmbeddingInput, hasEnoughToEmbed, embeddingFingerprint } = await import(
  '../src/services/embedding.js'
);
const { cosineSimilarity } = await import('../src/services/vectorSearch.js');
const { searchLinks } = await import('../src/services/search.js');
const { env } = await import('../src/config/env.js');

before(startTestDatabase);
after(stopTestDatabase);
afterEach(clearTestDatabase);

const USER_ID = '65b000000000000000000001';
const quiet = { warn: () => {}, error: () => {}, log: () => {} };

/** A vector of the configured width, pointing wherever the caller wants. */
function vector(fill = 0.1) {
  return Array.from({ length: env.EMBEDDING_DIMENSIONS }, () => fill);
}

/** A unit vector along one axis, so similarity between two is easy to predict. */
function axis(index) {
  const values = new Array(env.EMBEDDING_DIMENSIONS).fill(0);
  values[index] = 1;
  return values;
}

let counter = 0;

/** An enriched link, which is the state embedding normally sees. */
function saveEnriched(overrides = {}) {
  counter += 1;
  const url = `https://example.com/article-${counter}`;

  return Link.create({
    userId: USER_ID,
    url,
    canonicalUrl: url,
    domain: 'example.com',
    title: 'Redis Caching Strategies',
    description: 'Cache-aside, write-through and write-behind, compared.',
    summary: 'Patterns for caching API responses in Redis, and when each one fits.',
    tags: ['redis', 'caching'],
    processingStatus: 'ready',
    processedAt: new Date(),
    enrichmentStatus: 'done',
    ...overrides,
  });
}

/**
 * A worker with a fake provider. No suite run may spend money or need a
 * network, so the real call is never reachable from here -- which also means
 * these tests say nothing about embedding *quality*. They test the pipeline
 * around it: the claim, the budget, the retries and the fingerprint.
 */
function worker({ embed, bus = createMemoryBus({ logger: quiet }), reserveBudget } = {}) {
  const calls = [];

  const instance = createEmbeddingWorker({
    bus,
    logger: quiet,
    reserveBudget: reserveBudget ?? (async () => ({ allowed: true, count: 1, limit: 100 })),
    embed: async (input) => {
      calls.push(input);
      return embed ? embed(input) : { vector: vector() };
    },
  });

  return { instance, calls, bus };
}

const stored = (link) => Link.findById(link.id).select('+embedding');

describe('what gets embedded', () => {
  it('puts the summary and tags in front of the page text', () => {
    const input = buildEmbeddingInput({
      title: 'Redis Caching Strategies',
      summary: 'Patterns for caching API responses.',
      tags: ['redis', 'caching'],
      capture: { text: 'Skip to content. Menu. Home. About.' },
    });

    const lines = input.split('\n');

    assert.equal(lines[0], 'Redis Caching Strategies');
    assert.equal(lines[1], 'Patterns for caching API responses.');
    assert.ok(input.includes('redis, caching'));
    assert.ok(input.includes('Skip to content'));
  });

  /**
   * The Phase 5 finding, finally answered: three of four verification pages had
   * no `og:description`, so the summary is empty and the title is nearly all
   * the keyword index has. The captured page text is the only description of
   * those pages that exists anywhere in the system.
   */
  it('uses the captured page text when the page gave nothing else', () => {
    const input = buildEmbeddingInput({
      title: 'Two Sum',
      domain: 'leetcode.com',
      capture: { text: 'Given an array of integers, return indices of the two numbers.' },
    });

    assert.ok(input.includes('Given an array of integers'));
    assert.ok(hasEnoughToEmbed(input));
  });

  it('refuses to embed a link that is barely more than a hostname', () => {
    assert.equal(hasEnoughToEmbed(buildEmbeddingInput({ domain: 'example.com' })), false);
  });

  /**
   * Vectors from two models are points in unrelated spaces, so changing the
   * model has to invalidate the corpus rather than silently mix two of them.
   */
  it('fingerprints the model alongside the text', () => {
    const a = embeddingFingerprint('the same text', 'model-a');
    const b = embeddingFingerprint('the same text', 'model-b');

    assert.notEqual(a, b);
    assert.equal(a, embeddingFingerprint('the same text', 'model-a'));
  });
});

describe('the embedding worker', () => {
  it('writes a vector and announces it', async () => {
    const link = await saveEnriched();
    const { instance, bus } = worker();

    const published = [];
    await bus.subscribe({
      topic: TOPICS.EMBEDDING_CREATED,
      groupId: 'test',
      handler: async (payload) => published.push(payload),
    });

    assert.equal(await instance.handle({ linkId: link.id }), true);

    const after = await stored(link);
    assert.equal(after.embeddingStatus, 'done');
    assert.equal(after.embedding.length, env.EMBEDDING_DIMENSIONS);
    assert.ok(after.embeddedAt);
    assert.equal(published.length, 1);
    assert.equal(published[0].linkId, link.id);
  });

  it('does nothing, and bills nothing, for a redelivered event', async () => {
    const link = await saveEnriched();
    const { instance, calls } = worker();

    assert.equal(await instance.handle({ linkId: link.id }), true);
    assert.equal(await instance.handle({ linkId: link.id }), false);
    assert.equal(calls.length, 1);
  });

  /**
   * The second cost control, and the one the claim cannot provide. Enrichment
   * re-running and producing an identical summary is ordinary, and it sends the
   * link back to `pending` -- buying a byte-for-byte identical vector for it is
   * pure waste.
   */
  it('does not pay for a vector identical to the one it already has', async () => {
    const link = await saveEnriched();
    const { instance, calls } = worker();

    await instance.handle({ linkId: link.id });

    // Exactly what the save hook does when a searchable field is rewritten.
    await Link.updateOne({ _id: link.id }, { $set: { embeddingStatus: 'pending' } });

    assert.equal(await instance.handle({ linkId: link.id }), true);
    assert.equal(calls.length, 1, 'the fingerprint matched, so no second call');
    assert.equal((await stored(link)).embeddingStatus, 'done');
  });

  it('embeds again once the text actually changes', async () => {
    const link = await saveEnriched();
    const { instance, calls } = worker();

    await instance.handle({ linkId: link.id });

    const saved = await Link.findById(link.id);
    saved.title = 'Something else entirely';
    await saved.save();

    assert.equal(saved.embeddingStatus, 'pending', 'the save hook invalidates the vector');

    await instance.handle({ linkId: link.id });
    assert.equal(calls.length, 2);
  });

  it('skips a link with nothing worth embedding', async () => {
    const link = await saveEnriched({ title: '', description: '', summary: '', tags: [] });
    const { instance, calls } = worker();

    assert.equal(await instance.handle({ linkId: link.id }), true);
    assert.equal(calls.length, 0);
    assert.equal((await stored(link)).embeddingStatus, 'skipped');
  });

  it('retries a rate limit and gives up on a rejection', async () => {
    const failWith = (error) => worker({ embed: async () => Promise.reject(error) }).instance;

    const rateLimited = await saveEnriched();
    await failWith(
      new EmbeddingError('Rate limited', { retryable: true, status: 429 }),
    ).handle({ linkId: rateLimited.id });

    assert.equal((await stored(rateLimited)).embeddingStatus, 'pending');

    const rejected = await saveEnriched();
    await failWith(new EmbeddingError('Rejected (400)', { status: 400 })).handle({
      linkId: rejected.id,
    });

    assert.equal((await stored(rejected)).embeddingStatus, 'failed');
  });

  it('gives up once the attempts are spent', async () => {
    const link = await saveEnriched({ embeddingAttempts: MAX_EMBEDDING_ATTEMPTS - 1 });
    const { instance } = worker({
      embed: async () => {
        throw new EmbeddingError('Rate limited', { retryable: true, status: 429 });
      },
    });

    await instance.handle({ linkId: link.id });

    assert.equal((await stored(link)).embeddingStatus, 'failed');
  });

  /**
   * A spent budget is a condition of today and clears at midnight, so it must
   * not be recorded as a verdict on the link -- and the attempt is given back,
   * because the link has not failed at anything.
   */
  it('defers rather than skips when the daily ceiling is reached', async () => {
    const link = await saveEnriched();
    const { instance, calls } = worker({
      reserveBudget: async () => ({ allowed: false, count: 10, limit: 10 }),
    });

    assert.equal(await instance.handle({ linkId: link.id }), true);
    assert.equal(calls.length, 0);

    const after = await stored(link);
    assert.equal(after.embeddingStatus, 'pending');
    assert.equal(after.embeddingAttempts, 0, 'a refused reservation costs the link nothing');
  });
});

describe('the reaper, sweeping for embeddings', () => {
  /** Older than the grace period, so the text has visibly settled. */
  const settled = () => new Date(Date.now() - EMBEDDING_QUEUE_GRACE_MS - 1_000);

  async function age(link) {
    await Link.collection.updateOne({ _id: link._id }, { $set: { updatedAt: settled() } });
  }

  function reaper(bus, overrides = {}) {
    return createReaper({
      bus,
      logger: quiet,
      enrichmentEnabled: false,
      embeddingEnabled: true,
      ...overrides,
    });
  }

  it('republishes link.enriched for a link no live message reached', async () => {
    const link = await saveEnriched();
    await age(link);

    const bus = createMemoryBus({ logger: quiet });
    const published = [];
    await bus.subscribe({
      topic: TOPICS.LINK_ENRICHED,
      groupId: 'test',
      handler: async (payload) => published.push(payload),
    });

    await reaper(bus).runOnce();

    assert.equal(published.length, 1);
    assert.equal(published[0].linkId, link.id);
  });

  /**
   * A link's text changes twice in quick succession during normal processing --
   * extraction writes the title, enrichment writes the summary -- and each save
   * sends it back to `pending`. Embedding after the first buys a vector from
   * half the input and then immediately pays for a second one.
   */
  it('leaves a link whose text has just changed', async () => {
    await saveEnriched();

    const bus = createMemoryBus({ logger: quiet });
    const published = [];
    await bus.subscribe({
      topic: TOPICS.LINK_ENRICHED,
      groupId: 'test',
      handler: async (payload) => published.push(payload),
    });

    await reaper(bus).runOnce();

    assert.equal(published.length, 0);
  });

  it('publishes nothing when the daily budget is spent', async () => {
    const link = await saveEnriched();
    await age(link);

    const bus = createMemoryBus({ logger: quiet });
    const published = [];
    await bus.subscribe({
      topic: TOPICS.LINK_ENRICHED,
      groupId: 'test',
      handler: async (payload) => published.push(payload),
    });

    await reaper(bus, { hasEmbeddingBudget: async () => false }).runOnce();

    assert.equal(published.length, 0);
    assert.equal((await stored(link)).embeddingStatus, 'pending');
  });

  it('requeues a link whose message never arrived', async () => {
    const link = await saveEnriched({
      embeddingStatus: 'queued',
      embeddingQueuedAt: new Date(Date.now() - EMBEDDING_QUEUED_LEASE_MS - 1_000),
    });

    const { lostMessages } = await reclaimStaleEmbedding();

    assert.equal(lostMessages, 1);

    const after = await stored(link);
    assert.equal(after.embeddingStatus, 'pending');
    assert.equal(after.embeddingAttempts, 0, 'a lost message costs the link nothing');
  });

  it('recovers a claim whose process died mid-call', async () => {
    const link = await saveEnriched({
      embeddingStatus: 'processing',
      embeddingAttempts: 1,
      embeddingStartedAt: new Date(Date.now() - EMBEDDING_PROCESSING_LEASE_MS - 1_000),
    });

    const { abandonedWork } = await reclaimStaleEmbedding();

    assert.equal(abandonedWork, 1);
    assert.equal((await stored(link)).embeddingStatus, 'pending');
  });
});

describe('semantic search', () => {
  const params = (q, rest = {}) => ({ q, page: 1, limit: 20, ...rest });

  /** Runs a search with the semantic half on and a provider that cannot fail. */
  const search = (opts) =>
    searchLinks({ userId: USER_ID, semanticEnabled: true, logger: quiet, ...opts });

  it('scores identical vectors at one and orthogonal ones at zero', () => {
    assert.equal(Math.round(cosineSimilarity(axis(0), axis(0)) * 1000) / 1000, 1);
    assert.equal(cosineSimilarity(axis(0), axis(1)), 0);
    assert.equal(cosineSimilarity(axis(0), []), 0, 'a mismatched width is not comparable');
  });

  /**
   * The product thesis, and the thing keyword search provably cannot do: the
   * query shares no word with the document it should find.
   */
  it('finds a link that shares no word with the query', async () => {
    await saveEnriched({ title: 'Redis Caching Strategies', embedding: axis(0) });
    await saveEnriched({ title: 'Kafka Exactly-Once Semantics', embedding: axis(1) });

    const result = await search({
      params: params('make my backend snappier'),
      embed: async () => ({ vector: axis(0) }),
    });

    assert.equal(result.links.length, 1);
    assert.equal(result.links[0].title, 'Redis Caching Strategies');
    assert.equal(result.search.semantic, true);
    assert.equal(result.search.semanticMatches, 1);
  });

  /**
   * Without a floor, every vector has *some* similarity to every other and a
   * nonsense query would return the whole vault in a confident-looking order.
   */
  it('returns nothing rather than the nearest stranger', async () => {
    await saveEnriched({ title: 'Redis Caching Strategies', embedding: axis(0) });

    const result = await search({
      params: params('zzzz'),
      embed: async () => ({ vector: axis(1) }),
    });

    assert.equal(result.total, 0);
  });

  it('never returns another user vectors', async () => {
    await saveEnriched({ embedding: axis(0) });

    const result = await search({
      userId: '65b000000000000000000002',
      params: params('anything'),
      embed: async () => ({ vector: axis(0) }),
    });

    assert.equal(result.total, 0);
  });

  it('applies the structural filters to the semantic half too', async () => {
    await saveEnriched({ title: 'Redis Caching', embedding: axis(0), isFavorite: false });

    const unfiltered = await search({
      params: params('caching'),
      embed: async () => ({ vector: axis(0) }),
    });
    const filtered = await search({
      params: params('caching', { isFavorite: true }),
      embed: async () => ({ vector: axis(0) }),
    });

    assert.equal(unfiltered.total, 1);
    assert.equal(filtered.total, 0);
  });

  it('merges the two halves rather than letting either win outright', async () => {
    const keywordOnly = await saveEnriched({ title: 'Redis Caching Strategies' });
    const semanticOnly = await saveEnriched({ title: 'Nothing alike', embedding: axis(0) });

    const result = await search({
      params: params('redis'),
      embed: async () => ({ vector: axis(0) }),
    });

    const ids = result.links.map((link) => link.id);

    assert.equal(result.total, 2);
    assert.ok(ids.includes(keywordOnly.id));
    assert.ok(ids.includes(semanticOnly.id));
  });

  /**
   * Search must not stop working because a third party is having a bad
   * afternoon. The keyword half is unaffected and answers most queries.
   */
  it('degrades to keywords when the provider fails, and says so', async () => {
    await saveEnriched({ title: 'Redis Caching Strategies' });

    const result = await search({
      params: params('redis'),
      embed: async () => {
        throw new EmbeddingError('Could not reach the embedding model', { retryable: true });
      },
    });

    assert.equal(result.total, 1);
    assert.equal(result.search.semantic, false);
    assert.equal(result.search.semanticFailed, true);
  });

  it('does not call the provider at all when embeddings are off', async () => {
    await saveEnriched({ title: 'Redis Caching Strategies' });

    let called = false;
    const result = await searchLinks({
      userId: USER_ID,
      params: params('redis'),
      semanticEnabled: false,
      logger: quiet,
      embed: async () => {
        called = true;
        return { vector: axis(0) };
      },
    });

    assert.equal(called, false);
    assert.equal(result.total, 1);
    assert.equal(result.search.semantic, false);
    assert.equal(result.search.semanticFailed, false);
  });
});
