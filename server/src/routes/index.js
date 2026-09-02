import { Router } from 'express';

import { authRouter } from './authRoutes.js';
import { collectionRouter } from './collectionRoutes.js';
import { linkRouter } from './linkRoutes.js';

export const apiRouter = Router();

apiRouter.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/links', linkRouter);
apiRouter.use('/collections', collectionRouter);
