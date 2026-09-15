import { Router } from 'express';

import { createFeedbackSchema, postFeedback } from '../controllers/feedbackController.js';
import { byUser, createRateLimit, MINUTE_MS } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';

export const feedbackRouter = Router();

feedbackRouter.use(requireAuth);

/**
 * Generous on purpose. This is not a limit on how much feedback anyone may
 * send -- somebody working through a list of annoyances is exactly the user
 * worth hearing from, and cutting them off at the third note would be a
 * self-inflicted wound. It is only here so a stuck retry loop or a bored
 * account cannot fill the collection unattended.
 */
const feedbackLimiter = createRateLimit({
  name: 'feedback',
  limit: 10,
  windowMs: 10 * MINUTE_MS,
  keyBy: byUser,
  message: 'Thanks — that is a lot of feedback at once. Try again in a few minutes.',
});

feedbackRouter.post('/', feedbackLimiter, validate(createFeedbackSchema), postFeedback);
