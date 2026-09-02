import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import request from 'supertest';

// Set before helpers.js loads, because config/env.js validates at import time
// and these two values are what the tests below are about. A cap of three keeps
// the end-to-end test honest without saving a hundred bookmarks to reach it.
process.env.MAX_LINKS_PER_USER = '3';
process.env.ENRICHMENT_DAILY_LIMIT = '2';

const { clearTestDatabase, signUp, startTestDatabase, stopTestDatabase } =
  await import('./helpers.js');
const { createApp } = await import('../src/app.js');
const { Link } = await import('../src/models/Link.js');
const { DailyUsage } = await import('../src/models/DailyUsage.js');
const { assertLinkQuota, dayKey, enrichmentUsage, reserveEnrichment } = await import(
  '../src/services/usage.js'
);
const { createMemoryBus } = await import('../src/events/memoryBus.js');
const { createEnrichmentWorker } = await import('../src/workers/enrichmentWorker.js');
const { createReaper } = await import('../src/workers/reaper.js');

const app = createApp();

before(startTestDatabase);
after(stopTestDatabase);
afterEach(clearTestDatabase);

const USER_ID = '65b000000000000000000001';
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

const readyLink = (overrides = {}) =>
  Link.create({
    userId: USER_ID,
    url: 'https://example.com/a',
    canonicalUrl: 'https://example.com/a',
    domain: 'example.com',
    title: 'Redis caching strategies',
    description: 'How to cache well.',
    processingStatus: 'ready',
    processedAt: new Date(),
    ...overrides,
  });

describe('daily enrichment ceiling', () => {
  it('allows the day budget and then refuses', async () => {
    assert.equal((await reserveEnrichment({ limit: 2 })).allowed, true);
    assert.equal((await reserveEnrichment({ limit: 2 })).allowed, true);

    const refused = await reserveEnrichment({ limit: 2 });
    assert.equal(refused.allowed, false);
    assert.equal(refused.count, 2, 'a refused reservation must not inflate the counter');
  });

  it('keeps a separate budget per day', async () => {
    const today = new Date('2026-09-02T12:00:00Z');
    const tomorrow = new Date('2026-09-03T00:30:00Z');

    await reserveEnrichment({ limit: 1, now: today });
    assert.equal((await reserveEnrichment({ limit: 1, now: today })).allowed, false);

    assert.equal((await reserveEnrichment({ limit: 1, now: tomorrow })).allowed, true);
  });

  it('survives a restart, because the counter is in the database', async () => {
    await reserveEnrichment({ limit: 5 });
    await reserveEnrichment({ limit: 5 });

    // Nothing in process memory is consulted here: this is the state a fresh
    // process would read, which is the entire reason the counter is not in the
    // rate limit store alongside the throttles.
    const stored = await DailyUsage.findById('enrichment:' + dayKey());
    assert.equal(stored.count, 2);

    const usage = await enrichmentUsage({ limit: 5 });
    assert.equal(usage.count, 2);
    assert.equal(usage.remaining, 3);
    assert.equal(usage.exhausted, false);
  });

  it('reports exhaustion once the budget is spent', async () => {
    await reserveEnrichment({ limit: 1 });
    assert.equal((await enrichmentUsage({ limit: 1 })).exhausted, true);
  });
});

describe('the enrichment worker under the ceiling', () => {
  /** A worker whose budget always refuses, and which records any call it makes. */
  function starvedWorker() {
    let called = false;

    const worker = createEnrichmentWorker({
      bus: createMemoryBus({ logger: quiet }),
      enrich: async () => {
        called = true;
        return { summary: 'should never happen', tags: [] };
      },
      loadVocabulary: async () => [],
      reserveBudget: async () => ({ allowed: false, count: 2, limit: 2 }),
      logger: quiet,
    });

    return { worker, wasCalled: () => called };
  }

  it('never calls the provider once the budget is spent', async () => {
    const link = await readyLink();
    const { worker, wasCalled } = starvedWorker();

    await worker.handle({ linkId: link.id });

    assert.equal(wasCalled(), false, 'the ceiling exists to stop exactly this call');
  });

  it('defers the link rather than skipping it, so tomorrow can still enrich it', async () => {
    const link = await readyLink();
    const { worker } = starvedWorker();

    await worker.handle({ linkId: link.id });

    const saved = await Link.findById(link.id);
    assert.equal(saved.enrichmentStatus, 'pending', 'skipped would abandon it permanently');
    assert.equal(saved.enrichmentAttempts, 0, 'a refused reservation must not spend a retry');
    assert.equal(saved.summary, '');
  });

  it('stops the reaper publishing work that cannot be paid for', async () => {
    await readyLink({ processedAt: new Date(Date.now() - 120_000) });

    const bus = createMemoryBus({ logger: quiet });
    const reaper = createReaper({ bus, hasEnrichmentBudget: async () => false, logger: quiet });

    await reaper.runOnce();

    const enrichmentEvents = bus.published.filter((event) => event.topic === 'metadata.extracted');
    assert.equal(enrichmentEvents.length, 0);

    const link = await Link.findOne({});
    assert.equal(link.enrichmentStatus, 'pending', 'it should wait, not cycle through the lease');
  });

  it('publishes again once the budget is available', async () => {
    await readyLink({ processedAt: new Date(Date.now() - 120_000) });

    const bus = createMemoryBus({ logger: quiet });
    const reaper = createReaper({ bus, hasEnrichmentBudget: async () => true, logger: quiet });

    await reaper.runOnce();

    const enrichmentEvents = bus.published.filter((event) => event.topic === 'metadata.extracted');
    assert.equal(enrichmentEvents.length, 1);
  });
});

describe('per-user link quota', () => {
  it('throws once the account is at its cap', async () => {
    await assertLinkQuota(USER_ID, { limit: 1 });

    await readyLink();

    await assert.rejects(
      () => assertLinkQuota(USER_ID, { limit: 1 }),
      (error) => error.statusCode === 403,
    );
  });

  it('counts each account separately', async () => {
    await readyLink();

    // Another user's bookmarks are not this user's problem.
    await assertLinkQuota('65b000000000000000000002', { limit: 1 });
  });

  it('refuses a new save at the cap but still accepts a re-save', async () => {
    const { cookie } = await signUp(app);

    for (let index = 0; index < 3; index += 1) {
      const response = await request(app)
        .post('/api/links')
        .set('Cookie', cookie)
        .send({ url: 'https://example.com/page-' + index });
      assert.equal(response.status, 201);
    }

    const blocked = await request(app)
      .post('/api/links')
      .set('Cookie', cookie)
      .send({ url: 'https://example.com/one-too-many' });

    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error.message, /bookmark limit/);

    // Saving something already in the library creates nothing, so the cap has
    // no business refusing it -- and being told off for a re-save is exactly
    // the experience this product exists to avoid.
    const resaved = await request(app)
      .post('/api/links')
      .set('Cookie', cookie)
      .send({ url: 'https://example.com/page-1' });

    assert.equal(resaved.status, 200);
    assert.equal(resaved.body.created, false);
  });
});
