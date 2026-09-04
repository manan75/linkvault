import { Router } from 'express';

import { authRouter } from './authRoutes.js';
import { collectionRouter } from './collectionRoutes.js';
import { healthRouter } from './healthRoutes.js';
import { linkRouter } from './linkRoutes.js';

export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/links', linkRouter);
apiRouter.use('/collections', collectionRouter);
