import { Router } from 'express';

export const apiRouter = Router();

apiRouter.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});
