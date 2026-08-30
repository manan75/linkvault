import { Router } from 'express';

import {
  createLinkSchema,
  getLink,
  getLinks,
  getTags,
  listLinksSchema,
  patchLink,
  removeLink,
  retryLink,
  saveLink,
  updateLinkSchema,
} from '../controllers/linkController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';

export const linkRouter = Router();

// Bookmarks are private, so nothing here is reachable without a session.
linkRouter.use(requireAuth);

// Declared before `/:id` so "tags" is not read as a link id.
linkRouter.get('/tags', getTags);

linkRouter.post('/', validate(createLinkSchema), saveLink);
linkRouter.get('/', validate(listLinksSchema, 'query'), getLinks);
linkRouter.get('/:id', getLink);
linkRouter.patch('/:id', validate(updateLinkSchema), patchLink);
// POST rather than PATCH: this asks for work to happen, it does not set a field.
linkRouter.post('/:id/retry', retryLink);
linkRouter.delete('/:id', removeLink);
