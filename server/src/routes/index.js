import { Router } from 'express';

import { authRouter } from './authRoutes.js';

export const apiRouter = Router();

apiRouter.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

apiRouter.use('/auth', authRouter);
