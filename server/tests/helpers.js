import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Set before anything imports src/config/env.js, which validates at load time.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-value-that-is-long-enough';
process.env.MONGODB_URI = 'mongodb://placeholder/linkvault-test';

let memoryServer;

export async function startTestDatabase() {
  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri('linkvault-test'));
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
