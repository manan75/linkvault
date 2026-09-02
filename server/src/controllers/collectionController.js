import { z } from 'zod';

import {
  createCollection,
  deleteCollection,
  listCollections,
  renameCollection,
} from '../services/collectionService.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const nameSchema = z
  .string()
  .trim()
  .min(1, 'A name is required')
  .max(60, 'Name must be at most 60 characters');

export const createCollectionSchema = z.object({ name: nameSchema });
export const updateCollectionSchema = z.object({ name: nameSchema });

export const getCollections = asyncHandler(async (req, res) => {
  res.status(200).json(await listCollections(req.userId));
});

export const postCollection = asyncHandler(async (req, res) => {
  const collection = await createCollection({ userId: req.userId, name: req.body.name });
  res.status(201).json({ collection: collection.toPublicJSON() });
});

export const patchCollection = asyncHandler(async (req, res) => {
  const collection = await renameCollection({
    userId: req.userId,
    id: req.params.id,
    name: req.body.name,
  });
  res.status(200).json({ collection: collection.toPublicJSON() });
});

export const removeCollection = asyncHandler(async (req, res) => {
  const { releasedLinks } = await deleteCollection({ userId: req.userId, id: req.params.id });
  res.status(200).json({ releasedLinks });
});
