import { Feedback } from '../models/Feedback.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Records a message from a signed-in user.
 *
 * The account is read rather than trusted from the request because the email
 * stored here is what the owner will reply to, and the client has no business
 * naming it. `requireAuth` has already proved who is asking.
 */
export async function submitFeedback({ userId, message, path }) {
  const user = await User.findById(userId).select('email');

  // The session outlived the account -- a deleted user holding a valid cookie.
  // Rare, but storing feedback with no one to answer helps nobody.
  if (!user) throw ApiError.unauthorized();

  return Feedback.create({
    userId,
    email: user.email,
    message,
    path: path ?? '',
  });
}
