import { z } from 'zod';

import { submitFeedback } from '../services/feedbackService.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const createFeedbackSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, 'Say something first')
    .max(2000, 'Feedback must be at most 2000 characters'),

  /*
    The client sends where the user was. It is advisory context, not a
    permission, so a missing or silly value is trimmed and truncated rather
    than rejected -- failing someone's feedback over a bad path would throw
    away the thing being collected.
  */
  path: z.string().trim().max(200).optional(),
});

export const postFeedback = asyncHandler(async (req, res) => {
  const feedback = await submitFeedback({
    userId: req.userId,
    message: req.body.message,
    path: req.body.path,
  });

  res.status(201).json({ feedback: feedback.toPublicJSON() });
});
