import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Set before anything imports src/config/env.js, which validates at load time.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-value-that-is-long-enough';
process.env.MONGODB_URI = 'mongodb://placeholder/linkvault-test';

let memoryServer;

export async function startTestDatabase() {
  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri('linkvault-test'));

  // Index builds are otherwise racing the first insert, and the unique indexes
  // are part of what these tests assert.
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
}

export async function stopTestDatabase() {
  await mongoose.disconnect();
  await memoryServer?.stop();
}

export async function clearTestDatabase() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}

/** Extracts the session cookie from a supertest response, if one was set. */
export function sessionCookie(response) {
  const cookies = response.headers['set-cookie'] ?? [];
  return cookies.find((cookie) => cookie.startsWith('linkvault_token='));
}

let uniqueEmailCounter = 0;

/**
 * Registers a user and returns their session cookie, so ownership tests can set
 * up two accounts without repeating the auth dance.
 */
export async function signUp(app, overrides = {}) {
  uniqueEmailCounter += 1;

  const credentials = {
    name: 'Test User',
    email: `user${uniqueEmailCounter}@example.com`,
    password: 'correct-horse-battery',
    ...overrides,
  };

  const response = await request(app).post('/api/auth/register').send(credentials);

  if (response.status !== 201) {
    throw new Error(`Test setup failed to register a user: ${JSON.stringify(response.body)}`);
  }

  return { cookie: sessionCookie(response), user: response.body.user, credentials };
}
