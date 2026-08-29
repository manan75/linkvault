import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';

const SALT_ROUNDS = 12;

export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

export function issueToken(user) {
  return jwt.sign({ sub: user._id.toString() }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  });
}

/** Returns the user id encoded in the token, or throws ApiError(401). */
export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (!payload.sub) throw new Error('Token is missing a subject');
    return payload.sub;
  } catch {
    throw ApiError.unauthorized('Invalid or expired session');
  }
}

export async function registerUser({ name, email, password }) {
  const existing = await User.findOne({ email }).lean();
  if (existing) {
    throw ApiError.conflict('An account with that email already exists');
  }

  const passwordHash = await hashPassword(password);

  try {
    return await User.create({ name, email, passwordHash });
  } catch (error) {
    // The unique index is the real guard against a race between the check above
    // and the insert; translate its error into the same client-facing conflict.
    if (error?.code === 11000) {
      throw ApiError.conflict('An account with that email already exists');
    }
    throw error;
  }
}

export async function authenticateUser({ email, password }) {
  const user = await User.findOne({ email }).select('+passwordHash');

  // Compare against a dummy hash when no user exists so that response time does
  // not reveal whether the email is registered.
  const hash = user?.passwordHash ?? '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const passwordMatches = await verifyPassword(password, hash);

  if (!user || !passwordMatches) {
    throw ApiError.unauthorized('Incorrect email or password');
  }

  return user;
}

export async function findUserById(id) {
  return User.findById(id);
}
