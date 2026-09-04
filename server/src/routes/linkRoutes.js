import { Router } from 'express';

import {
  createLinkSchema,
  getLink,
  getLinks,
  getTags,
  listLinksSchema,
  patchLink,
  removeLink,
  renameTagEverywhere,
  renameTagSchema,
  retryLink,
  saveLink,
  updateLinkSchema,
} from '../controllers/linkController.js';
import { byUser, createRateLimit, MINUTE_MS } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';

export const linkRouter = Router();

// Bookmarks are private, so nothing here is reachable without a session.
linkRouter.use(requireAuth);

/**
 * Keyed by account rather than address, because the expensive resource is
 * billed per account. An IP limit would be the wrong shape twice over: it
 * would punish an office sharing an address, and an attacker with one account
 * and a handful of addresses would walk straight past it.
 *
 * Saving is the only endpoint here that costs anything -- a page fetch and a
 * model call -- so it is the only one limited. Reading is cheap and rate
 * limiting it would only make the dashboard feel broken.
 */
const saveLimiter = createRateLimit({
  name: 'save-link',
  limit: 20,
  windowMs: 60 * MINUTE_MS,
  keyBy: byUser,
  message: 'You are saving links unusually fast. Try again in a little while.',
});

// Declared before `/:id` so "tags" is not read as a link id.
linkRouter.get('/tags', getTags);
// Renaming onto an existing tag is the merge; there is no separate endpoint.
linkRouter.patch('/tags/:name', validate(renameTagSchema), renameTagEverywhere);

// The larger body limit this route needs for a page capture is applied in
// `app.js`, because the body is parsed before any router sees the request.
linkRouter.post('/', saveLimiter, validate(createLinkSchema), saveLink);
linkRouter.get('/', validate(listLinksSchema, 'query'), getLinks);
linkRouter.get('/:id', getLink);
linkRouter.patch('/:id', validate(updateLinkSchema), patchLink);
// POST rather than PATCH: this asks for work to happen, it does not set a field.
linkRouter.post('/:id/retry', retryLink);
linkRouter.delete('/:id', removeLink);
