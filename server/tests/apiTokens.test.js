import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

import {
  clearTestDatabase,
  signUp,
  startTestDatabase,
  stopTestDatabase,
} from './helpers.js';

const { createApp } = await import('../src/app.js');
const { ApiToken } = await import('../src/models/ApiToken.js');
const { MAX_TOKENS_PER_USER } = await import('../src/services/apiTokenService.js');

/**
 * The credential the browser extension uses, and the boundary around it.
 *
 * Two properties carry the weight here and both are asserted rather than
 * assumed: the token is never recoverable after the one response that issues
 * it, and it cannot be used to manage tokens -- including its own replacement.
 */
describe('access tokens', () => {
  const app = createApp();

  before(startTestDatabase);
  after(stopTestDatabase);
  beforeEach(clearTestDatabase);

  const mint = async (cookie, name = 'Chrome extension') =>
    request(app).post('/api/auth/tokens').set('Cookie', cookie).send({ name });

  it('issues a token once and stores only its hash', async () => {
    const { cookie } = await signUp(app);

    const response = await mint(cookie);

    assert.equal(response.status, 201);
    assert.match(response.body.token, /^lv_[A-Za-z0-9_-]{20,}$/);
    assert.equal(response.body.apiToken.name, 'Chrome extension');

    const stored = await ApiToken.findById(response.body.apiToken.id);
    assert.ok(stored.tokenHash);
    // The whole point: nothing in the row resembles the credential.
    assert.ok(!stored.tokenHash.includes(response.body.token));

    // And no later read ever hands it back.
    const listed = await request(app).get('/api/auth/tokens').set('Cookie', cookie);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.tokens.length, 1);
    assert.ok(!('token' in listed.body.tokens[0]));
  });

  it('authenticates a request with Authorization: Bearer', async () => {
    const { cookie, user } = await signUp(app);
    const { body } = await mint(cookie);

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${body.token}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.user.id, user.id);
  });

  it('reaches a user\'s own bookmarks and nobody else\'s', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);

    await request(app)
      .post('/api/links')
      .set('Cookie', alice.cookie)
      .send({ url: 'https://example.com/alice' });

    const { body } = await mint(bob.cookie);

    const response = await request(app)
      .get('/api/links')
      .set('Authorization', `Bearer ${body.token}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.links.length, 0, "Bob's token must not see Alice's links");
  });

  it('refuses a token that was revoked', async () => {
    const { cookie } = await signUp(app);
    const { body } = await mint(cookie);

    const revoked = await request(app)
      .delete(`/api/auth/tokens/${body.apiToken.id}`)
      .set('Cookie', cookie);

    assert.equal(revoked.status, 204);

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${body.token}`);

    assert.equal(response.status, 401);
  });

  it('refuses a token belonging to nobody, and a malformed header', async () => {
    for (const header of ['Bearer lv_nothing', 'Bearer garbage', 'lv_nothing', 'Bearer ']) {
      const response = await request(app).get('/api/auth/me').set('Authorization', header);
      assert.equal(response.status, 401, `expected 401 for ${JSON.stringify(header)}`);
    }
  });

  it('will not accept a session JWT presented as a bearer token', async () => {
    const { cookie } = await signUp(app);
    // `linkvault_token=<jwt>; Path=/; ...`
    const jwt = cookie.split('=')[1].split(';')[0];

    const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${jwt}`);

    // The session lives in the cookie and nowhere else. Honouring it here would
    // hand a working credential to anything that can read the header.
    assert.equal(response.status, 401);
  });

  it('will not let a token mint another token', async () => {
    const { cookie } = await signUp(app);
    const { body } = await mint(cookie);

    const response = await request(app)
      .post('/api/auth/tokens')
      .set('Authorization', `Bearer ${body.token}`)
      .send({ name: 'A second one' });

    // 403, not 401: the credential is valid and simply not allowed to do this.
    assert.equal(response.status, 403);

    const listed = await request(app)
      .get('/api/auth/tokens')
      .set('Authorization', `Bearer ${body.token}`);

    assert.equal(listed.status, 403);
  });

  it('caps how many tokens one account may hold', async () => {
    const { cookie } = await signUp(app);

    for (let i = 0; i < MAX_TOKENS_PER_USER; i += 1) {
      const response = await mint(cookie, `Client ${i}`);
      assert.equal(response.status, 201);
    }

    const overflow = await mint(cookie, 'One too many');
    assert.equal(overflow.status, 409);
  });

  it('will not revoke a token belonging to another account', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);

    const { body } = await mint(alice.cookie);

    const response = await request(app)
      .delete(`/api/auth/tokens/${body.apiToken.id}`)
      .set('Cookie', bob.cookie);

    // Indistinguishable from a token that does not exist, deliberately.
    assert.equal(response.status, 404);
    assert.ok(await ApiToken.findById(body.apiToken.id));
  });

  it('records that a token was used', async () => {
    const { cookie } = await signUp(app);
    const { body } = await mint(cookie);

    assert.equal(body.apiToken.lastUsedAt, null);

    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${body.token}`);

    const stored = await ApiToken.findById(body.apiToken.id);
    assert.ok(stored.lastUsedAt instanceof Date);
  });
});
