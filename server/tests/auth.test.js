import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import request from 'supertest';

import {
  clearTestDatabase,
  sessionCookie,
  startTestDatabase,
  stopTestDatabase,
} from './helpers.js';

const { createApp } = await import('../src/app.js');
const { User } = await import('../src/models/User.js');

const app = createApp();

const VALID_USER = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'correct-horse-battery',
};

before(startTestDatabase);
after(stopTestDatabase);
afterEach(clearTestDatabase);

async function registerValidUser() {
  return request(app).post('/api/auth/register').send(VALID_USER);
}

describe('POST /api/auth/register', () => {
  it('creates the account, returns the public user, and starts a session', async () => {
    const response = await registerValidUser();

    assert.equal(response.status, 201);
    assert.equal(response.body.user.email, 'ada@example.com');
    assert.equal(response.body.user.name, 'Ada Lovelace');
    assert.ok(response.body.user.id);
    assert.ok(sessionCookie(response), 'expected a session cookie');
  });

  it('never returns the password or its hash', async () => {
    const response = await registerValidUser();

    assert.equal(response.body.user.password, undefined);
    assert.equal(response.body.user.passwordHash, undefined);
  });

  it('stores a bcrypt hash rather than the plaintext password', async () => {
    await registerValidUser();

    const stored = await User.findOne({ email: VALID_USER.email }).select('+passwordHash');
    assert.notEqual(stored.passwordHash, VALID_USER.password);
    assert.match(stored.passwordHash, /^\$2[aby]\$/);
  });

  it('normalises the email to lowercase', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_USER, email: '  ADA@Example.COM ' });

    assert.equal(response.status, 201);
    assert.equal(response.body.user.email, 'ada@example.com');
  });

  it('rejects a malformed email', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_USER, email: 'not-an-email' });

    assert.equal(response.status, 400);
    assert.ok(response.body.error.details.some((detail) => detail.field === 'email'));
  });

  it('rejects a password shorter than 8 characters', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_USER, password: 'short' });

    assert.equal(response.status, 400);
    assert.ok(response.body.error.details.some((detail) => detail.field === 'password'));
  });

  it('rejects a missing name', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: VALID_USER.email, password: VALID_USER.password });

    assert.equal(response.status, 400);
  });

  it('rejects a duplicate email', async () => {
    await registerValidUser();
    const response = await registerValidUser();

    assert.equal(response.status, 409);
    assert.equal(await User.countDocuments({ email: VALID_USER.email }), 1);
  });
});

describe('POST /api/auth/login', () => {
  it('signs in with correct credentials and starts a session', async () => {
    await registerValidUser();

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: VALID_USER.email, password: VALID_USER.password });

    assert.equal(response.status, 200);
    assert.equal(response.body.user.email, VALID_USER.email);
    assert.ok(sessionCookie(response), 'expected a session cookie');
  });

  it('rejects a wrong password without starting a session', async () => {
    await registerValidUser();

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: VALID_USER.email, password: 'wrong-password' });

    assert.equal(response.status, 401);
    assert.equal(sessionCookie(response), undefined);
  });

  it('gives the same response for an unknown email as for a wrong password', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: VALID_USER.password });

    assert.equal(response.status, 401);
    assert.equal(response.body.error.message, 'Incorrect email or password');
  });
});

describe('GET /api/auth/me', () => {
  it('returns the signed-in user', async () => {
    const registration = await registerValidUser();

    const response = await request(app)
      .get('/api/auth/me')
      .set('Cookie', sessionCookie(registration));

    assert.equal(response.status, 200);
    assert.equal(response.body.user.email, VALID_USER.email);
  });

  it('rejects a request with no session cookie', async () => {
    const response = await request(app).get('/api/auth/me');
    assert.equal(response.status, 401);
  });

  it('rejects a tampered token', async () => {
    const response = await request(app)
      .get('/api/auth/me')
      .set('Cookie', 'linkvault_token=not.a.real.token');

    assert.equal(response.status, 401);
  });

  it('rejects a valid token whose account no longer exists', async () => {
    const registration = await registerValidUser();
    await User.deleteMany({});

    const response = await request(app)
      .get('/api/auth/me')
      .set('Cookie', sessionCookie(registration));

    assert.equal(response.status, 401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session so protected routes reject the old cookie', async () => {
    const registration = await registerValidUser();

    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', sessionCookie(registration));

    assert.equal(logout.status, 204);

    const cleared = sessionCookie(logout);
    assert.ok(cleared, 'expected the session cookie to be overwritten');

    const followUp = await request(app).get('/api/auth/me').set('Cookie', cleared);
    assert.equal(followUp.status, 401);
  });
});
