import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import request from 'supertest';

import { clearTestDatabase, signUp, startTestDatabase, stopTestDatabase } from './helpers.js';

const { createApp } = await import('../src/app.js');
const { createMemoryRateLimitStore } = await import('../src/rateLimit/memoryStore.js');
const { byIp, byUser, createRateLimit } = await import('../src/middleware/rateLimit.js');

const app = createApp();

before(startTestDatabase);
after(stopTestDatabase);
afterEach(clearTestDatabase);

/** Drives middleware without an HTTP server, so the assertions are about the limiter. */
async function run(limiter, req = {}) {
  const headers = {};
  const res = { setHeader: (name, value) => { headers[name] = value; } };

  let nexted = false;
  let error = null;

  await new Promise((resolve) => {
    limiter(req, res, (err) => {
      if (err) error = err;
      else nexted = true;
      resolve();
    });
  });

  return { headers, nexted, error };
}

describe('memory rate limit store', () => {
  it('counts hits inside one window', async () => {
    const store = createMemoryRateLimitStore();

    assert.equal((await store.hit('a', 1000)).count, 1);
    assert.equal((await store.hit('a', 1000)).count, 2);
    // A different key is a different budget.
    assert.equal((await store.hit('b', 1000)).count, 1);
  });

  it('starts a fresh window once the old one has expired', async () => {
    const store = createMemoryRateLimitStore();
    const start = Date.now();

    await store.hit('a', 1000, start);
    const second = await store.hit('a', 1000, start + 500);
    assert.equal(second.count, 2);

    const afterExpiry = await store.hit('a', 1000, start + 1001);
    assert.equal(afterExpiry.count, 1, 'the window should reset rather than keep counting');
  });

  it('drops expired windows, so unique addresses cannot grow it without bound', async () => {
    const store = createMemoryRateLimitStore();
    const start = Date.now();

    await store.hit('one', 1000, start);
    await store.hit('two', 1000, start);
    assert.equal(store.size, 2);

    store.sweep(start + 1001);
    assert.equal(store.size, 0);
  });
});

describe('rate limit middleware', () => {
  it('allows requests under the limit and reports what is left', async () => {
    const limiter = createRateLimit({
      name: 'test',
      limit: 2,
      windowMs: 60_000,
      keyBy: byIp,
      store: createMemoryRateLimitStore(),
    });

    const first = await run(limiter, { ip: '1.2.3.4' });
    assert.equal(first.nexted, true);
    assert.equal(first.headers['RateLimit-Remaining'], 1);

    const second = await run(limiter, { ip: '1.2.3.4' });
    assert.equal(second.nexted, true);
    assert.equal(second.headers['RateLimit-Remaining'], 0);
  });

  it('rejects with 429 once the limit is passed', async () => {
    const limiter = createRateLimit({
      name: 'test',
      limit: 1,
      windowMs: 60_000,
      keyBy: byIp,
      store: createMemoryRateLimitStore(),
    });

    await run(limiter, { ip: '1.2.3.4' });
    const blocked = await run(limiter, { ip: '1.2.3.4' });

    assert.equal(blocked.nexted, false);
    assert.equal(blocked.error.statusCode, 429);
    assert.ok(blocked.headers['Retry-After'] >= 1, 'a 429 should say when to come back');
  });

  it('budgets each subject separately', async () => {
    const store = createMemoryRateLimitStore();
    const limiter = createRateLimit({ name: 'test', limit: 1, windowMs: 60_000, keyBy: byIp, store });

    await run(limiter, { ip: '1.1.1.1' });
    const other = await run(limiter, { ip: '2.2.2.2' });

    assert.equal(other.nexted, true, 'one address must not spend another address budget');
  });

  it('skips rather than fails closed when there is no key to limit by', async () => {
    // A per-user limiter mounted ahead of requireAuth. Letting the request
    // through leaves the route unprotected; failing closed would lock everyone
    // out of it, which is the worse of the two.
    const limiter = createRateLimit({
      name: 'test',
      limit: 0,
      windowMs: 60_000,
      keyBy: byUser,
      store: createMemoryRateLimitStore(),
    });

    const result = await run(limiter, {});
    assert.equal(result.nexted, true);
  });
});

describe('rate limits on the API', () => {
  it('stops repeated failed sign-ins', async () => {
    const { credentials } = await signUp(app);
    const wrong = { email: credentials.email, password: 'not-the-password' };

    // The limit is 10 in fifteen minutes; the eleventh is refused.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(app).post('/api/auth/login').send(wrong);
      assert.equal(response.status, 401, `attempt ${attempt + 1} should fail on the password`);
    }

    const limited = await request(app).post('/api/auth/login').send(wrong);
    assert.equal(limited.status, 429);
    assert.match(limited.body.error.message, /Too many sign-in attempts/);
  });

  it('does not let a limited endpoint spend another endpoint budget', async () => {
    const { credentials } = await signUp(app);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app).post('/api/auth/login').send({ email: credentials.email, password: 'no' });
    }

    assert.equal((await request(app).post('/api/auth/login').send({})).status, 429);

    // Registration has its own counter, so it is unaffected.
    const registered = await request(app).post('/api/auth/register').send({
      name: 'Someone Else',
      email: 'separate-budget@example.com',
      password: 'correct-horse-battery',
    });
    assert.equal(registered.status, 201);
  });
});
