import mongoose from 'mongoose';

import { env } from './env.js';

/** Connects to MongoDB. Throws if the connection cannot be established. */
export async function connectDatabase(uri = env.MONGODB_URI) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
