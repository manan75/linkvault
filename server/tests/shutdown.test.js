import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { clearTestDatabase, startTestDatabase, stopTestDatabase } from './helpers.js';

const { Link } = await import('../src/models/Link.js');
const { createDrain } = await import('../src/workers/drain.js');
const { createMemoryBus } = await import('../src/events/memoryBus.js');
const { createMetadataWorker } = await import('../src/workers/metadataWorker.js');

before(startTestDatabase);
after(stopTestDatabase);
afterEach(clearTestDatabase);

const USER_ID = '65b000000000000000000001';
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

const pendingLink = (path = 'article') =>
  Link.create({
    userId: USER_ID,
    url: 'https://example.com/' + path,
    canonicalUrl: 'https://example.com/' + path,
    domain: 'example.com',
  });

/** A promise with its resolver exposed, so a test can hold work open deliberately. */
function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('drain', () => {
  it('waits for work that is already running', async () => {
    const drain = createDrain();
    const held = deferred();

    let finished = false;
    drain.track(async () => {
      await held.promise;
      finished = true;
    });

    let drained = false;
    const draining = drain.drain().then(() => {
      drained = true;
    });

    // Give the drain every chance to resolve early, which is the bug this
    // guards against: exiting while work is still in flight.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false, 'drain resolved before the work finished');

    held.resolve();
    await draining;

    assert.equal(finished, true);
    assert.equal(drained, true);
  });

  it('resolves immediately when nothing is in flight', async () => {
    const drain = createDrain();
    await drain.drain();
    assert.equal(drain.size, 0);
  });

  it('does not let a failing handler stop the drain', async () => {
    const drain = createDrain();

    // The rejection is tracked and swallowed internally; asserting on the
    // returned promise keeps it handled here too.
    await assert.rejects(() => drain.track(async () => {
      throw new Error('handler blew up');
    }));

    await drain.drain();
    assert.equal(drain.size, 0);
  });
});

describe('metadata worker shutdown', () => {
  it('finishes the page it is already fetching', async () => {
    const link = await pendingLink();
    const held = deferred();

    const worker = createMetadataWorker({
      bus: createMemoryBus({ logger: quiet }),
      fetchPage: async () => {
        await held.promise;
        return {
          url: 'https://example.com/article',
          status: 200,
          contentType: 'text/html',
          body: Buffer.from('<title>Held</title>', 'utf8'),
        };
      },
      logger: quiet,
    });

    const running = worker.handle({ linkId: link.id });

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, 'stop must not abandon a fetch in flight');

    held.resolve();
    await running;
    await stopping;

    // The link reached a terminal state rather than being stranded mid-claim,
    // which is the whole point: an abandoned claim waits for the stale-lease
    // sweep, and on a platform that redeploys often that is a constant drip.
    const saved = await Link.findById(link.id);
    assert.equal(saved.processingStatus, 'ready');
    assert.equal(saved.title, 'Held');
  });

  it('declines new work once shutdown has begun', async () => {
    const link = await pendingLink('second');
    let fetched = false;

    const worker = createMetadataWorker({
      bus: createMemoryBus({ logger: quiet }),
      fetchPage: async () => {
        fetched = true;
        throw new Error('should not be reached');
      },
      logger: quiet,
    });

    await worker.stop();

    const handled = await worker.handle({ linkId: link.id });

    assert.equal(handled, false);
    assert.equal(fetched, false);

    // Nothing was claimed, so the next process finds it exactly as it was and
    // the reaper publishes it again. Declining costs nothing.
    const saved = await Link.findById(link.id);
    assert.equal(saved.processingStatus, 'pending');
    assert.equal(saved.processingAttempts, 0);
  });
});
