import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import request from 'supertest';

import { clearTestDatabase, signUp, startTestDatabase, stopTestDatabase } from './helpers.js';

const { createApp } = await import('../src/app.js');
const { Feedback } = await import('../src/models/Feedback.js');

const app = createApp();

before(startTestDatabase);
after(stopTestDatabase);
afterEach(clearTestDatabase);

const send = (cookie, body) =>
  request(app).post('/api/feedback').set('Cookie', cookie).send(body);

describe('POST /api/feedback', () => {
  it('records a message against the signed-in account', async () => {
    const { cookie, user } = await signUp(app);

    const response = await send(cookie, { message: '  Search missed my Redis link  ', path: '/' });

    assert.equal(response.status, 201);
    assert.equal(response.body.feedback.message, 'Search missed my Redis link');

    const stored = await Feedback.findOne({});
    assert.equal(stored.userId.toString(), user.id);
    assert.equal(stored.path, '/');
  });

  it('stores the account email so a reply needs no second lookup', async () => {
    const { cookie, credentials } = await signUp(app);

    await send(cookie, { message: 'The dark theme is lovely' });

    const stored = await Feedback.findOne({});
    assert.equal(stored.email, credentials.email);
  });

  it('never lets the client choose whose feedback this is', async () => {
    const { cookie, credentials } = await signUp(app);

    await send(cookie, {
      message: 'Spoofing attempt',
      email: 'someone-else@example.com',
      userId: '507f1f77bcf86cd799439011',
    });

    const stored = await Feedback.findOne({});
    assert.equal(stored.email, credentials.email);
  });

  it('rejects an empty message', async () => {
    const { cookie } = await signUp(app);

    const response = await send(cookie, { message: '   ' });

    assert.equal(response.status, 400);
    assert.equal(await Feedback.countDocuments({}), 0);
  });

  it('rejects a message past the length cap', async () => {
    const { cookie } = await signUp(app);

    const response = await send(cookie, { message: 'x'.repeat(2001) });

    assert.equal(response.status, 400);
    assert.equal(await Feedback.countDocuments({}), 0);
  });

  it('truncates nothing but refuses an over-long path without losing the message', async () => {
    const { cookie } = await signUp(app);

    const response = await send(cookie, { message: 'Fine', path: '/'.repeat(201) });

    // The path is advisory, but validation is at the boundary: a bad request is
    // a bad request. What matters is that the message itself was never stored
    // half-formed.
    assert.equal(response.status, 400);
    assert.equal(await Feedback.countDocuments({}), 0);
  });

  it('requires authentication', async () => {
    const response = await request(app).post('/api/feedback').send({ message: 'Anonymous' });

    assert.equal(response.status, 401);
    assert.equal(await Feedback.countDocuments({}), 0);
  });

  it('limits how fast one account can send', async () => {
    const { cookie } = await signUp(app);

    const statuses = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await send(cookie, { message: `Note ${attempt}` });
      statuses.push(response.status);
    }

    assert.equal(statuses.filter((status) => status === 201).length, 10);
    assert.ok(statuses.includes(429));
  });

  it('keeps one account from reading another through this route', async () => {
    const { cookie: first } = await signUp(app);
    const { cookie: second } = await signUp(app);

    await send(first, { message: 'First user note' });
    await send(second, { message: 'Second user note' });

    // There is no GET. Stated as a test so adding one later has to decide
    // deliberately who may read it, rather than inheriting the default.
    const response = await request(app).get('/api/feedback').set('Cookie', first);
    assert.equal(response.status, 404);
  });
});
