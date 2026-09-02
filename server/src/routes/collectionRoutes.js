import { Router } from 'express';

import {
  createCollectionSchema,
  getCollections,
  patchCollection,
  postCollection,
  removeCollection,
  updateCollectionSchema,
} from '../controllers/collectionController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';

export const collectionRouter = Router();

collectionRouter.use(requireAuth);

collectionRouter.get('/', getCollections);
collectionRouter.post('/', validate(createCollectionSchema), postCollection);
collectionRouter.patch('/:id', validate(updateCollectionSchema), patchCollection);
collectionRouter.delete('/:id', removeCollection);
