import { z } from 'zod';

import {
  createLink,
  deleteLink,
  getOwnedLink,
  listLinks,
  listTags,
  renameTag,
  retryProcessing,
  updateLink,
} from '../services/linkService.js';
import { LINK_SORTS, UNCATEGORISED } from '../services/linkQuery.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { reaper } from '../workers/runtime.js';

const MAX_TAGS = 20;

/**
 * Tags are labels, not prose: lowercasing and de-duplicating them here keeps
 * "React" and "react" from splitting one topic across two filter entries.
 */
const tagsSchema = z
  .array(z.string().trim().min(1).max(40))
  .max(MAX_TAGS, `A link can have at most ${MAX_TAGS} tags`)
  .transform((tags) => [...new Set(tags.map((tag) => tag.toLowerCase()))]);

/** Query strings arrive as a single value or a repeated one; normalise to a list. */
const listOfStrings = z.preprocess(
  (value) => (value === undefined ? undefined : [].concat(value)),
  z.array(z.string().trim().min(1).max(40)).max(MAX_TAGS).optional(),
);

/** `z.coerce.boolean()` treats the string "false" as true, so parse explicitly. */
const booleanFlag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid id');

export const createLinkSchema = z.object({
  url: z.string().trim().min(1, 'A URL is required').max(2048, 'That URL is too long'),
  // Optional: saving without choosing a collection stays one paste and one click.
  collectionId: objectIdSchema.nullish(),
});

export const updateLinkSchema = z
  .object({
    title: z.string().trim().max(300).optional(),
    description: z.string().trim().max(2000).optional(),
    tags: tagsSchema.optional(),
    // `null` removes the link from its collection.
    collectionId: objectIdSchema.nullable().optional(),
    isFavorite: z.boolean().optional(),
    isRead: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one field to update',
  });

export const renameTagSchema = z.object({
  name: z.string().trim().min(1, 'A new tag name is required').max(40),
});

export const listLinksSchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  tag: listOfStrings,
  collectionId: z.union([objectIdSchema, z.literal(UNCATEGORISED)]).optional(),
  domain: z.string().trim().max(255).optional(),
  isFavorite: booleanFlag,
  isRead: booleanFlag,
  savedAfter: z.coerce.date().optional(),
  savedBefore: z.coerce.date().optional(),
  sort: z.enum(LINK_SORTS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const saveLink = asyncHandler(async (req, res) => {
  const { link, created, moved } = await createLink({
    userId: req.userId,
    url: req.body.url,
    collectionId: req.body.collectionId,
  });

  // Principle 2: the response does not wait for extraction. The nudge only
  // wakes the reaper early so the link is published while the user is still
  // looking at the row, instead of up to one sweep later.
  if (created) reaper.nudge();

  // 200 rather than 201 when the bookmark already existed, so the client can
  // tell the user "already saved" instead of implying a second copy was made.
  res.status(created ? 201 : 200).json({ link: link.toPublicJSON(), created, moved });
});

export const getLinks = asyncHandler(async (req, res) => {
  res.status(200).json(await listLinks({ userId: req.userId, params: req.query }));
});

export const getLink = asyncHandler(async (req, res) => {
  const link = await getOwnedLink({ userId: req.userId, id: req.params.id });
  res.status(200).json({ link: link.toPublicJSON() });
});

export const patchLink = asyncHandler(async (req, res) => {
  const link = await updateLink({ userId: req.userId, id: req.params.id, patch: req.body });
  res.status(200).json({ link: link.toPublicJSON() });
});

export const retryLink = asyncHandler(async (req, res) => {
  const link = await retryProcessing({ userId: req.userId, id: req.params.id });
  reaper.nudge();

  res.status(200).json({ link: link.toPublicJSON() });
});

export const removeLink = asyncHandler(async (req, res) => {
  await deleteLink({ userId: req.userId, id: req.params.id });
  res.status(204).end();
});

export const getTags = asyncHandler(async (req, res) => {
  res.status(200).json({ tags: await listTags(req.userId) });
});

/**
 * Renames one tag across the user's whole library, merging if the target
 * already exists.
 *
 * The tag is in the path rather than the body because it identifies the thing
 * being changed. It arrives percent-encoded, and Express has already decoded
 * `req.params` for us.
 */
export const renameTagEverywhere = asyncHandler(async (req, res) => {
  const result = await renameTag({
    userId: req.userId,
    from: req.params.name,
    to: req.body.name,
  });

  // The refreshed vocabulary rides along so the sidebar does not need a second
  // round trip to show the result of what the user just did.
  res.status(200).json({ ...result, tags: await listTags(req.userId) });
});
