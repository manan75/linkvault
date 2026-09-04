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

/**
 * What the browser extension may send about the page it is looking at.
 *
 * Every field is optional and every field is a maximum, not an expectation: the
 * extension reads whatever the page happens to expose. Nothing here is trusted
 * -- `parseCapture` sanitises all of it before it reaches the database -- so
 * these bounds exist to stop an oversized body, not to validate content.
 *
 * `.passthrough()` is deliberately absent. An unknown key is dropped rather
 * than stored, so a newer extension sending a field this server does not know
 * about degrades instead of writing something nothing will ever read.
 */
const captureSchema = z.object({
  title: z.string().max(1000).optional(),
  description: z.string().max(5000).optional(),
  author: z.string().max(500).optional(),
  favicon: z.string().max(2048).optional(),
  thumbnail: z.string().max(2048).optional(),
  // Generously bounded here and truncated to `MAX_CAPTURE_TEXT` on the way in;
  // the extension already trims, and this is the backstop if it does not.
  text: z.string().max(100_000).optional(),
});

export const createLinkSchema = z.object({
  url: z.string().trim().min(1, 'A URL is required').max(2048, 'That URL is too long'),
  // Optional: saving without choosing a collection stays one paste and one click.
  collectionId: objectIdSchema.nullish(),
  // Only the extension sends this. The web app posts a URL and nothing else.
  capture: captureSchema.optional(),
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
  const { link, created, moved, recaptured } = await createLink({
    userId: req.userId,
    url: req.body.url,
    collectionId: req.body.collectionId,
    capture: req.body.capture,
  });

  // Principle 2: the response does not wait for extraction. The nudge only
  // wakes the reaper early so the link is published while the user is still
  // looking at the row, instead of up to one sweep later.
  //
  // `recaptured` nudges for the same reason: the link already existed but has
  // just been handed page content the server could not reach on its own, and it
  // is back at `pending` waiting to be reprocessed.
  if (created || recaptured) reaper.nudge();

  // 200 rather than 201 when the bookmark already existed, so the client can
  // tell the user "already saved" instead of implying a second copy was made.
  res
    .status(created ? 201 : 200)
    .json({ link: link.toPublicJSON(), created, moved, recaptured });
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
