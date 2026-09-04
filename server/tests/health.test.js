import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import request from 'supertest';

import { startTestDatabase, stopTestDatabase } from './helpers.js';

const { createApp } = await import('../src/app.js');
const { resetHealthCache } = await import('../src/routes/healthRoutes.js');

/**
 * The split between the two endpoints is the thing under test.
 *
 * `/health` exists to be hit every few minutes forever so a free Render
 * instance never spins down; it must therefore be incapable of reporting
 * anything but "the process is listening". `/health/deep` exists to tell the
 * truth about whether the app works, which means it must be able to fail.
 */
describe('health', () => {
  const app = createApp();

  before(startTestDatabase);
  after(stopTestDatabase);
  beforeEach(resetHealthCache);

  it('reports ok on the shallow check', async () => {
    const response = await request(app).get('/api/health');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: 'ok' });
  });

  it('reports ok on the deep check when the database answers', async () => {
    const response = await request(app).get('/api/health/deep');

    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
    assert.equal(response.body.checks.database.ok, true);
  });

  /**
   * Pretends the connection is in `state` for the duration of `run`.
   *
   * Shadows the prototype accessor with an own *getter* and deletes it
   * afterwards, which restores the real one. Defining an own data property
   * instead leaves behind something mongoose's own `close()` cannot assign to,
   * and teardown then fails after every assertion has already passed -- which
   * is exactly how this was first written.
   *
   * Stubbed rather than genuinely disconnected because the connection is shared
   * with every other suite in the run.
   */
  async function withReadyState(state, run) {
    Object.defineProperty(mongoose.connection, 'readyState', {
      get: () => state,
      configurable: true,
    });

    try {
      await run();
    } finally {
      delete mongoose.connection.readyState;
    }
  }

  it('reports 503 on the deep check when the database is not connected', async () => {
    await withReadyState(0, async () => {
      const response = await request(app).get('/api/health/deep');

      assert.equal(response.status, 503);
      assert.equal(response.body.status, 'degraded');
      assert.equal(response.body.checks.database.ok, false);
      assert.equal(response.body.checks.database.detail, 'disconnected');
    });

    // And the real accessor is back, so the shared connection still works.
    assert.equal(mongoose.connection.readyState, 1);
  });

  it('reports 503 when the database is connected but does not answer', async () => {
    const admin = mongoose.connection.db.admin.bind(mongoose.connection.db);

    // The failure that actually matters in production: not a refused
    // connection but an unreachable cluster, where the command never settles.
    mongoose.connection.db.admin = () => ({ ping: () => new Promise(() => {}) });

    try {
      const response = await request(app).get('/api/health/deep');

      assert.equal(response.status, 503);
      assert.match(response.body.checks.database.detail, /did not answer in time/);
    } finally {
      mongoose.connection.db.admin = admin;
    }
  });

  it('keeps the shallow check green while the deep one is red', async () => {
    await withReadyState(0, async () => {
      // The whole reason there are two paths: a platform health check or a
      // keep-warm ping aimed here must not start restarting the service
      // because the database is briefly unreachable.
      const response = await request(app).get('/api/health');
      assert.equal(response.status, 200);
    });
  });

  it('reuses a verdict rather than pinging the database per request', async () => {
    const admin = mongoose.connection.db.admin.bind(mongoose.connection.db);
    let pings = 0;

    mongoose.connection.db.admin = () => ({
      ping: async () => {
        pings += 1;
        return admin().ping();
      },
    });

    try {
      await request(app).get('/api/health/deep');
      await request(app).get('/api/health/deep');
      await request(app).get('/api/health/deep');

      // Unauthenticated and hittable by anyone, so the cache is what stops it
      // amplifying a flood into load on the database it is meant to watch.
      assert.equal(pings, 1);
    } finally {
      mongoose.connection.db.admin = admin;
    }
  });
});
