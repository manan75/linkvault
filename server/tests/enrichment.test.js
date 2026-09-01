import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { clearTestDatabase, startTestDatabase, stopTestDatabase } from './helpers.js';

const { Link } = await import('../src/models/Link.js');
const { createMemoryBus } = await import('../src/events/memoryBus.js');
const { TOPICS } = await import('../src/events/topics.js');
const { createReaper } = await import('../src/workers/reaper.js');
const { createEnrichmentWorker } = await import('../src/workers/enrichmentWorker.js');
const {
  ENRICHMENT_PROCESSING_LEASE_MS,
  ENRICHMENT_QUEUED_LEASE_MS,
  ENRICHMENT_QUEUE_GRACE_MS,
  MAX_ENRICHMENT_ATTEMPTS,
  reclaimStaleEnrichment,
} = await import('../src/workers/enrichmentQueue.js');
const { EnrichmentError } = await import('../src/services/enrichmentError.js');
const { hasEnoughToEnrich, buildEnrichmentInput } = await import('../src/services/enrichment.js');

before(startTestDatabase);
after(stopTestDatabase);
afterEach(clearTestDatabase);

const USER_ID = '65b000000000000000000001';
const quiet = { warn: () => {}, error: () => {} };

/** An extracted link, which is the only state enrichment ever sees. */
function saveExtracted(overrides = {}) {
  return Link.create({
    userId: USER_ID,
    url: 'https://example.com/article',
    canonicalUrl: 'https://example.com/article',
    domain: 'example.com',
    title: 'Redis Caching Strategies',
    description: 'Cache-aside, write-through and write-behind, compared.',
    processingStatus: 'ready',
    processedAt: new Date(),
    ...overrides,
  });
}

/**
 * A worker with a fake provider. No suite run may spend money or need a
 * network, so the real call is never reachable from here -- which also means
 * these tests say nothing about summary quality. That is what the real-API run
 * in the phase notes is for.
 */
function worker({ enrich, vocabulary = [], bus = createMemoryBus({ logger: quiet }) } = {}) {
  const calls = [];

  const instance = createEnrichmentWorker({
    bus,
    logger: quiet,
    loadVocabulary: async () => vocabulary.map((name) => ({ name, count: 1 })),
    enrich: async (input) => {
      calls.push(input);
      return enrich ? enrich(input) : { summary: 'A summary.', tags: ['redis', 'caching'] };
    },
  });

  return { worker: instance, calls, bus };
}

describe('enrichment worker', () => {
  it('writes the summary and auto-tags, and publishes link.enriched', async () => {
    const link = await saveExtracted();
    const bus = createMemoryBus({ logger: quiet });
    const enriched = [];
    await bus.subscribe({
      topic: TOPICS.LINK_ENRICHED,
      groupId: 'test',
      handler: (event) => enriched.push(event),
    });

    const { worker: instance } = worker({ bus });
    assert.equal(await instance.handle({ linkId: link.id }), true);
    await bus.drain();

    const stored = await Link.findById(link.id);
    assert.equal(stored.summary, 'A summary.');
    assert.deepEqual(stored.autoTags, ['redis', 'caching']);
    assert.deepEqual(stored.tags, ['redis', 'caching']);
    assert.equal(stored.enrichmentStatus, 'done');
    assert.ok(stored.enrichedAt);
    assert.equal(stored.enrichmentError, '');

    assert.deepEqual(
      enriched.map((event) => event.linkId),
      [link.id],
    );
  });

  it('shows the model the user’s vocabulary and snaps output onto it', async () => {
    const link = await saveExtracted();
    const { worker: instance, calls } = worker({
      vocabulary: ['PostgreSQL', 'performance'],
      enrich: async () => ({ summary: '', tags: ['postgresql', 'Performance', 'redis'] }),
    });

    await instance.handle({ linkId: link.id });

    assert.deepEqual(calls[0].vocabulary, ['PostgreSQL', 'performance']);

    // The case snap is what stops `postgresql` becoming a second sidebar entry
    // alongside the `PostgreSQL` the user already has.
    const stored = await Link.findById(link.id);
    assert.deepEqual(stored.autoTags, ['PostgreSQL', 'performance', 'redis']);
  });

  it('keeps the link usable when the model returns no summary', async () => {
    const link = await saveExtracted();
    const { worker: instance } = worker({
      enrich: async () => ({ summary: '', tags: ['redis'] }),
    });

    await instance.handle({ linkId: link.id });

    const stored = await Link.findById(link.id);
    // An empty summary is the model refusing to invent one, not a failure.
    assert.equal(stored.summary, '');
    assert.deepEqual(stored.tags, ['redis']);
    assert.equal(stored.enrichmentStatus, 'done');
    assert.equal(stored.processingStatus, 'ready');
  });

  it('never overwrites a summary the user typed', async () => {
    const link = await saveExtracted({ summary: 'Mine, thanks.' });
    const { worker: instance } = worker();

    await instance.handle({ linkId: link.id });

    const stored = await Link.findById(link.id);
    assert.equal(stored.summary, 'Mine, thanks.');
    // The generated tags still land: only the occupied field is protected.
    assert.deepEqual(stored.autoTags, ['redis', 'caching']);
  });
});

describe('enrichment skip conditions', () => {
  it('knows when there is nothing worth sending', () => {
    assert.equal(hasEnoughToEnrich({ title: '', description: '', domain: 'example.com' }), false);
    // What extraction leaves behind for a page with no metadata at all.
    assert.equal(
      hasEnoughToEnrich({ title: 'example.com', description: '', domain: 'example.com' }),
      false,
    );
    assert.equal(
      hasEnoughToEnrich({ title: 'www.example.com', description: '', domain: 'example.com' }),
      false,
    );
    assert.equal(
      hasEnoughToEnrich({ title: 'Redis Caching', description: '', domain: 'example.com' }),
      true,
    );
    assert.equal(hasEnoughToEnrich({ title: '', description: 'A page.', domain: 'x.com' }), true);
  });

  it('reads only the fields the plan allows the model to see', () => {
    const input = buildEnrichmentInput({
      title: '  Redis  ',
      description: '',
      domain: 'example.com',
      url: 'https://example.com/secret-path',
      author: 'Someone',
    });

    assert.deepEqual(input, { title: 'Redis', description: '', domain: 'example.com' });
  });

  it('skips without calling the provider, and does not count it as a failure', async () => {
    const link = await saveExtracted({ title: 'example.com', description: '' });
    const { worker: instance, calls } = worker();

    assert.equal(await instance.handle({ linkId: link.id }), true);

    assert.equal(calls.length, 0, 'a link with nothing to say must never be billed');

    const stored = await Link.findById(link.id);
    assert.equal(stored.enrichmentStatus, 'skipped');
    assert.equal(stored.processingStatus, 'ready');
  });
});

describe('enrichment provenance', () => {
  it('merges auto-tags into tags the user has not touched', async () => {
    const link = await saveExtracted({ tags: ['reading-list'] });
    const { worker: instance } = worker();

    await instance.handle({ linkId: link.id });

    const stored = await Link.findById(link.id);
    assert.deepEqual(stored.tags, ['reading-list', 'redis', 'caching']);
  });

  it('never touches tags once the user has edited them', async () => {
    // The scenario the flag exists for: the user deleted an auto-tag they
    // disliked, and it must not come back on the next enrichment.
    const link = await saveExtracted({ tags: ['redis'], tagsEditedByUser: true });
    const { worker: instance } = worker();

    await instance.handle({ linkId: link.id });

    const stored = await Link.findById(link.id);
    assert.deepEqual(stored.tags, ['redis'], 'caching was deleted by the user and must stay gone');
    // The record of what the model produced is still kept, for the UI and for
    // any future backfill.
    assert.deepEqual(stored.autoTags, ['redis', 'caching']);
    assert.equal(stored.enrichmentStatus, 'done');
  });
});

describe('enrichment idempotency', () => {
  it('does not bill a second call for a redelivered event', async () => {
    const link = await saveExtracted();
    const { worker: instance, calls } = worker();

    assert.equal(await instance.handle({ linkId: link.id }), true);
    assert.equal(await instance.handle({ linkId: link.id }), false);
    assert.equal(await instance.handle({ linkId: link.id }), false);

    assert.equal(calls.length, 1, 'at-least-once delivery must not mean at-least-once billing');
    assert.equal((await Link.findById(link.id)).enrichmentAttempts, 1);
  });

  it('does not re-enrich a link that was skipped', async () => {
    const link = await saveExtracted({ title: 'example.com', description: '' });
    const { worker: instance, calls } = worker();

    await instance.handle({ linkId: link.id });
    assert.equal(await instance.handle({ linkId: link.id }), false);
    assert.equal(calls.length, 0);
  });

  it('ignores an event for a link whose extraction failed', async () => {
    const link = await saveExtracted({ processingStatus: 'failed', title: '', description: '' });
    const { worker: instance, calls } = worker();

    assert.equal(await instance.handle({ linkId: link.id }), false);
    assert.equal(calls.length, 0);
  });
});

describe('enrichment failure handling', () => {
  const failWith = (error) => () => {
    throw error;
  };

  it('retries a rate limit and leaves the bookmark perfectly usable', async () => {
    const link = await saveExtracted();
    const { worker: instance } = worker({
      enrich: failWith(new EnrichmentError('Rate limited', { retryable: true, status: 429 })),
    });

    await instance.handle({ linkId: link.id });

    const stored = await Link.findById(link.id);
    assert.equal(stored.enrichmentStatus, 'pending', 'a 429 is worth another go');
    assert.equal(stored.enrichmentAttempts, 1);
    // §8: enrichment failing must not make the link look broken.
    assert.equal(stored.processingStatus, 'ready');
  });

  it('treats a timeout as retryable', async () => {
    const link = await saveExtracted();
    const { worker: instance } = worker({
      enrich: failWith(new EnrichmentError('The model timed out', { retryable: true })),
    });

    await instance.handle({ linkId: link.id });

    assert.equal((await Link.findById(link.id)).enrichmentStatus, 'pending');
  });

  it('gives up immediately on a rejected request', async () => {
    const link = await saveExtracted();
    const bus = createMemoryBus({ logger: quiet });
    const failures = [];
    await bus.subscribe({
      topic: TOPICS.PROCESSING_FAILED,
      groupId: 'test',
      handler: (event) => failures.push(event),
    });

    const { worker: instance } = worker({
      bus,
      enrich: failWith(new EnrichmentError('The model rejected the request (400)', { status: 400 })),
    });

    await instance.handle({ linkId: link.id });
    await bus.drain();

    const stored = await Link.findById(link.id);
    assert.equal(stored.enrichmentStatus, 'failed');
    assert.equal(stored.enrichmentAttempts, 1, 'retrying a 400 cannot help');
    assert.equal(stored.processingStatus, 'ready');

    assert.equal(failures.length, 1);
    assert.equal(failures[0].stage, 'enrichment');
  });

  it('gives up once the attempt budget is spent', async () => {
    const link = await saveExtracted({ enrichmentAttempts: MAX_ENRICHMENT_ATTEMPTS - 1 });
    const { worker: instance } = worker({
      enrich: failWith(new EnrichmentError('Rate limited', { retryable: true, status: 429 })),
    });

    await instance.handle({ linkId: link.id });

    const stored = await Link.findById(link.id);
    assert.equal(stored.enrichmentAttempts, MAX_ENRICHMENT_ATTEMPTS);
    assert.equal(stored.enrichmentStatus, 'failed');
  });

  it('treats an unexpected error as permanent rather than looping on it', async () => {
    const link = await saveExtracted();
    const { worker: instance } = worker({ enrich: failWith(new TypeError('bug')) });

    await instance.handle({ linkId: link.id });

    const stored = await Link.findById(link.id);
    assert.equal(stored.enrichmentStatus, 'failed');
    assert.equal(stored.enrichmentError, 'Could not generate a summary');
  });
});

describe('enrichment lease recovery', () => {
  it('requeues a link whose message never arrived', async () => {
    const link = await saveExtracted({
      enrichmentStatus: 'queued',
      enrichmentQueuedAt: new Date(Date.now() - ENRICHMENT_QUEUED_LEASE_MS - 1_000),
    });

    const { lostMessages } = await reclaimStaleEnrichment();

    assert.equal(lostMessages, 1);
    const stored = await Link.findById(link.id);
    assert.equal(stored.enrichmentStatus, 'pending');
    assert.equal(stored.enrichmentAttempts, 0, 'a lost message costs the link nothing');
  });

  it('recovers a claim whose process died mid-call', async () => {
    const link = await saveExtracted({
      enrichmentStatus: 'processing',
      enrichmentAttempts: 1,
      enrichmentStartedAt: new Date(Date.now() - ENRICHMENT_PROCESSING_LEASE_MS - 1_000),
    });

    const { abandonedWork } = await reclaimStaleEnrichment();

    assert.equal(abandonedWork, 1);
    assert.equal((await Link.findById(link.id)).enrichmentStatus, 'pending');
  });

  it('fails an abandoned claim that has no attempts left', async () => {
    const link = await saveExtracted({
      enrichmentStatus: 'processing',
      enrichmentAttempts: MAX_ENRICHMENT_ATTEMPTS,
      enrichmentStartedAt: new Date(Date.now() - ENRICHMENT_PROCESSING_LEASE_MS - 1_000),
    });

    await reclaimStaleEnrichment();

    assert.equal((await Link.findById(link.id)).enrichmentStatus, 'failed');
  });

  it('leaves a fresh claim alone', async () => {
    const link = await saveExtracted({
      enrichmentStatus: 'processing',
      enrichmentStartedAt: new Date(),
    });

    await reclaimStaleEnrichment();

    assert.equal((await Link.findById(link.id)).enrichmentStatus, 'processing');
  });
});

describe('reaper enrichment sweep', () => {
  const reaperFor = (bus, options = {}) => createReaper({ bus, logger: quiet, ...options });

  /** Older than the grace period, so the live message has visibly not worked. */
  const stranded = (overrides = {}) =>
    saveExtracted({
      processedAt: new Date(Date.now() - ENRICHMENT_QUEUE_GRACE_MS - 1_000),
      ...overrides,
    });

  it('republishes metadata.extracted for a link the live message never reached', async () => {
    const link = await stranded();
    const bus = createMemoryBus({ logger: quiet });
    const seen = [];
    await bus.subscribe({
      topic: TOPICS.METADATA_EXTRACTED,
      groupId: 'test',
      handler: (event) => seen.push(event),
    });

    assert.equal(await reaperFor(bus).runOnce(), 1);
    await bus.drain();

    assert.deepEqual(
      seen.map((event) => event.linkId),
      [link.id],
    );
    assert.equal((await Link.findById(link.id)).enrichmentStatus, 'queued');
  });

  it('leaves a freshly extracted link to the live message', async () => {
    // Without the grace the sweep would race every `metadata.extracted` the
    // metadata worker emits and double every message in the system.
    await saveExtracted({ processedAt: new Date() });
    const bus = createMemoryBus({ logger: quiet });

    assert.equal(await reaperFor(bus).runOnce(), 0);
  });

  it('picks up links saved before enrichment existed', async () => {
    // No `enrichmentAttempts` and no `processedAt`: a Phase 2 bookmark. The
    // `$in: [null, 0]` in the claim filter is the only reason this matches.
    await Link.collection.insertOne({
      userId: new (await import('mongoose')).default.Types.ObjectId(USER_ID),
      url: 'https://example.com/old',
      canonicalUrl: 'https://example.com/old',
      domain: 'example.com',
      title: 'An old bookmark',
      description: 'Saved long before any of this existed.',
      tags: [],
      processingStatus: 'ready',
      enrichmentStatus: 'pending',
      savedAt: new Date('2026-07-01'),
    });

    const bus = createMemoryBus({ logger: quiet });
    assert.equal(await reaperFor(bus).runOnce(), 1);
  });

  it('does not sweep for enrichment when it is disabled', async () => {
    // No consumer exists without a key, so republishing would cycle every link
    // in the library through the queued lease and back, forever.
    const link = await stranded();
    const bus = createMemoryBus({ logger: quiet });

    assert.equal(await reaperFor(bus, { enrichmentEnabled: false }).runOnce(), 0);
    assert.equal((await Link.findById(link.id)).enrichmentStatus, 'pending');
  });

  it('does not sweep a link extraction never finished', async () => {
    await stranded({ processingStatus: 'failed' });
    const bus = createMemoryBus({ logger: quiet });

    assert.equal(await reaperFor(bus).runOnce(), 0);
  });

  it('hands the link back when the publish fails', async () => {
    const link = await stranded();
    const bus = {
      publish: async () => {
        throw new Error('broker down');
      },
    };

    assert.equal(await reaperFor(bus).runOnce(), 0);
    assert.equal((await Link.findById(link.id)).enrichmentStatus, 'pending');
  });
});
