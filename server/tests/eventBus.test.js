import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMemoryBus } from '../src/events/memoryBus.js';

const quiet = { warn: () => {}, error: () => {} };

describe('memory event bus', () => {
  it('delivers a published message to a subscriber', async () => {
    const bus = createMemoryBus({ logger: quiet });
    const seen = [];

    await bus.subscribe({ topic: 'link.created', handler: (payload) => seen.push(payload) });
    await bus.publish('link.created', 'abc', { linkId: 'abc' });
    await bus.drain();

    assert.deepEqual(seen, [{ linkId: 'abc' }]);
  });

  it('records what was published, for assertions', async () => {
    const bus = createMemoryBus({ logger: quiet });

    await bus.publish('link.created', 'abc', { linkId: 'abc' });

    assert.deepEqual(bus.published, [
      { topic: 'link.created', key: 'abc', payload: { linkId: 'abc' } },
    ]);
  });

  it('does not block the publisher on a slow handler', async () => {
    const bus = createMemoryBus({ logger: quiet });
    let finished = false;

    await bus.subscribe({
      topic: 'link.created',
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        finished = true;
      },
    });

    await bus.publish('link.created', 'abc', { linkId: 'abc' });
    assert.equal(finished, false, 'publish should return before the handler finishes');

    await bus.drain();
    assert.equal(finished, true);
  });

  it('bounds concurrent delivery the way a consumer group does', async () => {
    // Without this bound, flag-off would fire one fetch per saved link at once.
    const bus = createMemoryBus({ concurrency: 2, logger: quiet });
    let active = 0;
    let peak = 0;

    await bus.subscribe({
      topic: 'link.created',
      handler: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
      },
    });

    for (let index = 0; index < 6; index += 1) {
      await bus.publish('link.created', `link-${index}`, { linkId: `link-${index}` });
    }
    await bus.drain();

    assert.equal(peak, 2);
  });

  it('keeps going when a handler throws', async () => {
    const bus = createMemoryBus({ logger: quiet });
    const seen = [];

    await bus.subscribe({
      topic: 'link.created',
      handler: ({ linkId }) => {
        if (linkId === 'bad') throw new Error('poison');
        seen.push(linkId);
      },
    });

    await bus.publish('link.created', 'bad', { linkId: 'bad' });
    await bus.publish('link.created', 'good', { linkId: 'good' });
    await bus.drain();

    // A poison message must not stall everything behind it.
    assert.deepEqual(seen, ['good']);
  });
});
