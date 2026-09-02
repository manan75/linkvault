import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { clearTestDatabase, startTestDatabase, stopTestDatabase } from './helpers.js';

const { Link } = await import('../src/models/Link.js');
const { createMemoryBus } = await import('../src/events/memoryBus.js');
const { TOPICS } = await import('../src/events/topics.js');
const { createReaper } = await import('../src/workers/reaper.js');
const { createMetadataWorker } = await import('../src/workers/metadataWorker.js');
const { reclaimStale } = await import('../src/workers/linkQueue.js');
const { FetchError } = await import('../src/services/safeFetch.js');

before(startTestDatabase);
after(stopTestDatabase);
afterEach(clearTestDatabase);

const USER_ID = '65b000000000000000000001';
const quiet = { warn: () => {}, error: () => {} };

const htmlResponse = (html, url = 'https://example.com/article') => ({
  url,
  status: 200,
  contentType: 'text/html; charset=utf-8',
  body: Buffer.from(html, 'utf8'),
});

function savePending(overrides = {}) {
  return Link.create({
    userId: USER_ID,
    url: 'https://example.com/article',
    canonicalUrl: 'https://example.com/article',
    domain: 'example.com',
    ...overrides,
  });
}

/** The whole pipeline on an in-process bus: reaper publishes, worker consumes. */
function pipeline(fetchPage, busOptions = {}) {
  const bus = createMemoryBus({ logger: quiet, ...busOptions });
  const worker = createMetadataWorker({ bus, fetchPage, logger: quiet });
  const reaper = createReaper({ bus, logger: quiet });

  return { bus, worker, reaper };
}

/** Runs one reaper sweep and waits for everything it published to be handled. */
async function runPipeline(parts) {
  await parts.worker.start();
  const published = await parts.reaper.runOnce();
  await parts.bus.drain();
  return published;
}

describe('reaper', () => {
  it('publishes a pending link and marks it queued', async () => {
    const link = await savePending();
    const { bus, reaper } = pipeline(async () => htmlResponse('<title>x</title>'));

    assert.equal(await reaper.runOnce(), 1);

    assert.equal(bus.published.length, 1);
    assert.equal(bus.published[0].topic, TOPICS.LINK_CREATED);
    assert.equal(bus.published[0].key, link.id);
    assert.equal(bus.published[0].payload.linkId, link.id);

    const updated = await Link.findById(link.id);
    assert.equal(updated.processingStatus, 'queued');
    assert.ok(updated.queuedAt);
  });

  it('carries only ids, never a copy of the bookmark', async () => {
    await savePending({ title: 'Private note to self' });
    const { bus, reaper } = pipeline(async () => htmlResponse(''));

    await reaper.runOnce();

    // Putting the document in the message would make the log a second durable
    // store of private bookmark content, and guarantee stale reads.
    assert.deepEqual(Object.keys(bus.published[0].payload).sort(), [
      'linkId',
      'occurredAt',
      'userId',
    ]);
  });

  it('does not republish a link it has already queued', async () => {
    await savePending();
    const { bus, reaper } = pipeline(async () => htmlResponse(''));

    await reaper.runOnce();
    await reaper.runOnce();

    // Without the `queued` status this would publish on every single sweep.
    assert.equal(bus.published.length, 1);
  });

  it('puts a link back to pending when the publish fails', async () => {
    const link = await savePending();
    const { reaper } = pipeline(async () => htmlResponse(''));
    reaper.stop();

    const broken = createReaper({
      bus: {
        publish: async () => {
          throw new Error('broker unreachable');
        },
      },
      logger: quiet,
    });

    assert.equal(await broken.runOnce(), 0);

    // The dual-write trap: the status moved but the event never existed. If it
    // stayed `queued` the link would wait a full lease for nothing.
    const updated = await Link.findById(link.id);
    assert.equal(updated.processingStatus, 'pending');
    assert.equal(updated.queuedAt, null);
  });

  it('does not wedge when a publish never settles', async () => {
    const link = await savePending();

    // kafkajs does not reject when the broker is unreachable -- it retries the
    // seed broker forever and `send` simply never settles. Before the deadline
    // was added this hung `runOnce`, left `isTicking` true, and stopped the
    // sweep permanently: a broker outage stalled the pipeline until restart,
    // taking stale-lease recovery down with it.
    const neverSettles = createReaper({
      bus: { publish: () => new Promise(() => {}) },
      publishTimeoutMs: 50,
      logger: quiet,
    });

    assert.equal(await neverSettles.runOnce(), 0);

    const updated = await Link.findById(link.id);
    assert.equal(updated.processingStatus, 'pending', 'a written-off publish must release');
  });

  it('keeps recovering stale leases while publishing is broken', async () => {
    // The outage that stops publishing is exactly when recovery matters most,
    // so reclaim must not sit behind the publish loop.
    const link = await savePending({
      processingStatus: 'queued',
      queuedAt: new Date(Date.now() - 5 * 60_000),
    });

    const broken = createReaper({
      bus: { publish: () => new Promise(() => {}) },
      publishTimeoutMs: 50,
      logger: quiet,
    });

    await broken.runOnce();

    // Reclaimed to pending, then re-queued and written off again -- either way
    // it is no longer stranded at its original lease.
    const updated = await Link.findById(link.id);
    assert.equal(updated.processingStatus, 'pending');
  });

  it('backs off instead of hammering a broker that is down', async () => {
    await savePending();
    await savePending({ url: 'https://b.example/', canonicalUrl: 'https://b.example/' });

    let attempts = 0;
    const failing = createReaper({
      bus: {
        publish: async () => {
          attempts += 1;
          throw new Error('broker unreachable');
        },
      },
      cooldownMs: 60_000,
      logger: quiet,
    });

    await failing.runOnce();
    await failing.runOnce();

    // One failure per sweep, and the second sweep skipped publishing entirely.
    assert.equal(attempts, 1);
  });

  it('publishes nothing when the queue is empty', async () => {
    const { reaper } = pipeline(async () => htmlResponse(''));

    assert.equal(await reaper.runOnce(), 0);
  });

  it('claims a link saved before the attempt counter existed', async () => {
    const link = await savePending();
    // Phase 2 wrote links with no `processingAttempts` at all, and a schema
    // default does not reach documents that already exist. Mongo will not match
    // a missing field against 0.
    await Link.collection.updateOne({ _id: link._id }, { $unset: { processingAttempts: '' } });

    const parts = pipeline(async () => htmlResponse('<title>Legacy</title>'));
    await runPipeline(parts);

    const updated = await Link.findById(link.id);
    assert.equal(updated.processingStatus, 'ready');
    assert.equal(updated.title, 'Legacy');
  });
});

describe('metadata worker as a consumer', () => {
  it('fills a link from the page and marks it ready', async () => {
    const link = await savePending();

    const parts = pipeline(async () =>
      htmlResponse(`
        <title>Ignored</title>
        <meta property="og:title" content="Redis Caching Strategies" />
        <meta property="og:description" content="Faster APIs." />
        <meta name="author" content="Jane Roe" />
        <meta property="og:image" content="/hero.png" />
      `),
    );
    await runPipeline(parts);

    const updated = await Link.findById(link.id);

    assert.equal(updated.processingStatus, 'ready');
    assert.equal(updated.title, 'Redis Caching Strategies');
    assert.equal(updated.description, 'Faster APIs.');
    assert.equal(updated.author, 'Jane Roe');
    assert.equal(updated.thumbnail, 'https://example.com/hero.png');
    assert.ok(updated.processedAt);
    assert.equal(updated.queuedAt, null);
  });

  it('publishes metadata.extracted for the next stage', async () => {
    const link = await savePending();
    const parts = pipeline(async () => htmlResponse('<title>Done</title>'));

    await runPipeline(parts);

    // Nothing consumes this yet. Phase 5 subscribes without touching this code.
    const extracted = parts.bus.published.filter((m) => m.topic === TOPICS.METADATA_EXTRACTED);
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].payload.linkId, link.id);
  });

  it('never overwrites what the user typed', async () => {
    const link = await savePending({ title: 'My own title' });

    const parts = pipeline(async () =>
      htmlResponse(
        '<meta property="og:title" content="Site title"><meta name="description" content="Site blurb">',
      ),
    );
    await runPipeline(parts);

    const updated = await Link.findById(link.id);
    assert.equal(updated.title, 'My own title');
    assert.equal(updated.description, 'Site blurb');
  });

  it('ignores a redelivered event for a link it already processed', async () => {
    const link = await savePending();
    let fetches = 0;

    const parts = pipeline(async () => {
      fetches += 1;
      return htmlResponse('<title>Once</title>');
    });
    await runPipeline(parts);

    // Kafka is at-least-once. The same event arriving twice must be harmless.
    const didWork = await parts.worker.handle({ linkId: link.id });

    assert.equal(didWork, false);
    assert.equal(fetches, 1);
  });

  it('leaves nothing to parse when the response is not HTML', async () => {
    const link = await savePending();

    const parts = pipeline(async () => ({
      url: 'https://example.com/paper.pdf',
      status: 200,
      contentType: 'application/pdf',
      body: Buffer.from('%PDF-1.7'),
    }));
    await runPipeline(parts);

    const updated = await Link.findById(link.id);
    assert.equal(updated.processingStatus, 'ready');
    assert.equal(updated.title, '');
  });
});

describe('pipeline failure handling', () => {
  it('sends a permanent failure straight to failed and announces it', async () => {
    const link = await savePending();

    const parts = pipeline(async () => {
      throw new FetchError('http', 'The site returned 404', { status: 404 });
    });
    await runPipeline(parts);

    const updated = await Link.findById(link.id);
    assert.equal(updated.processingStatus, 'failed');
    assert.equal(updated.processingError, 'The site returned 404');
    assert.equal(updated.processingAttempts, 1);

    const failures = parts.bus.published.filter((m) => m.topic === TOPICS.PROCESSING_FAILED);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].payload.stage, 'metadata');
    assert.equal(failures[0].payload.linkId, link.id);
  });

  it('returns a transient failure to pending without announcing a failure', async () => {
    const link = await savePending();

    const parts = pipeline(async () => {
      throw new FetchError('timeout', 'That site took too long to respond', { retryable: true });
    });
    await runPipeline(parts);

    const updated = await Link.findById(link.id);
    assert.equal(updated.processingStatus, 'pending', 'a timeout is worth another go');
    assert.equal(updated.processingAttempts, 1);

    // Not terminal, so nothing should be told the link failed.
    assert.equal(parts.bus.published.filter((m) => m.topic === TOPICS.PROCESSING_FAILED).length, 0);
  });

  it('gives up after three attempts', async () => {
    const link = await savePending();

    const parts = pipeline(async () => {
      throw new FetchError('timeout', 'That site took too long to respond', { retryable: true });
    });
    await parts.worker.start();

    for (const attempt of [1, 2, 3]) {
      // The backoff ladder holds the link back until enough time has passed, so
      // the test moves the clock rather than waiting on it.
      await Link.updateOne({ _id: link.id }, { processingStartedAt: new Date(0) });
      await parts.reaper.runOnce();
      await parts.bus.drain();

      assert.equal((await Link.findById(link.id)).processingAttempts, attempt);
    }

    assert.equal((await Link.findById(link.id)).processingStatus, 'failed');
  });

  it('holds a failed link back until its backoff has passed', async () => {
    await savePending();

    const parts = pipeline(async () => {
      throw new FetchError('network', 'socket hang up', { retryable: true });
    });

    assert.equal(await runPipeline(parts), 1);
    // Straight back round: the link is pending again but not yet due.
    assert.equal(await parts.reaper.runOnce(), 0);
  });

  it('does not let one bad URL stop the others', async () => {
    await savePending({ url: 'https://broken.example/a', canonicalUrl: 'https://broken.example/a' });
    await savePending({ url: 'https://fine.example/b', canonicalUrl: 'https://fine.example/b' });

    const parts = pipeline(async (url) => {
      if (url.includes('broken')) throw new FetchError('http', 'The site returned 500');
      return htmlResponse('<title>Fine</title>');
    });
    assert.equal(await runPipeline(parts), 2);

    const fine = await Link.findOne({ canonicalUrl: 'https://fine.example/b' });
    assert.equal(fine.processingStatus, 'ready');
    assert.equal(fine.title, 'Fine');
  });

  it('records an unexpected error without leaking its detail', async () => {
    const link = await savePending();

    const parts = pipeline(async () => {
      throw new TypeError('cannot read properties of undefined (reading "mongoUri")');
    });
    await runPipeline(parts);

    const updated = await Link.findById(link.id);
    assert.equal(updated.processingStatus, 'failed');
    assert.equal(updated.processingError, 'Could not read that page');
  });
});

describe('stale lease recovery', () => {
  it('requeues a link whose event never reached a consumer', async () => {
    // The broker went down after the status write, or the message was lost.
    const link = await savePending({
      processingStatus: 'queued',
      queuedAt: new Date(Date.now() - 5 * 60_000),
    });

    const { lostMessages } = await reclaimStale();

    assert.equal(lostMessages, 1);
    const updated = await Link.findById(link.id);
    assert.equal(updated.processingStatus, 'pending');
    // A message that never arrived costs the site nothing.
    assert.equal(updated.processingAttempts, 0);
  });

  it('leaves a freshly queued link alone', async () => {
    const link = await savePending({ processingStatus: 'queued', queuedAt: new Date() });

    await reclaimStale();

    assert.equal((await Link.findById(link.id)).processingStatus, 'queued');
  });

  it('hands back a claim that died mid-fetch', async () => {
    const link = await savePending({
      processingStatus: 'processing',
      processingAttempts: 1,
      processingStartedAt: new Date(Date.now() - 10 * 60_000),
    });

    const parts = pipeline(async () => htmlResponse('<title>Recovered</title>'));
    await runPipeline(parts);

    const updated = await Link.findById(link.id);
    assert.equal(updated.processingStatus, 'ready');
    assert.equal(updated.title, 'Recovered');
  });

  it('fails an abandoned claim that has used its attempts', async () => {
    const link = await savePending({
      processingStatus: 'processing',
      processingAttempts: 3,
      processingStartedAt: new Date(Date.now() - 10 * 60_000),
    });

    const parts = pipeline(async () => htmlResponse('<title>Never</title>'));
    await runPipeline(parts);

    const updated = await Link.findById(link.id);
    assert.equal(updated.processingStatus, 'failed');
    assert.equal(updated.processingError, 'Processing was interrupted');
  });

  it('leaves a claim that is still within its lease alone', async () => {
    const link = await savePending({
      processingStatus: 'processing',
      processingAttempts: 1,
      processingStartedAt: new Date(),
    });

    const parts = pipeline(async () => htmlResponse('<title>No</title>'));
    assert.equal(await runPipeline(parts), 0);
    assert.equal((await Link.findById(link.id)).processingStatus, 'processing');
  });
});
