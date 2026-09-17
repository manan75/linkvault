/**
 * Identifiers shared between the things that can be dragged and the things they
 * can be dropped on. They are strings because dnd-kit compares them by value,
 * and they are namespaced because collection ids and the bin share one space.
 */

import { UNCATEGORISED } from '../hooks/useVault';

export const TRASH_DROP_ID = 'lv-trash';

const COLLECTION_PREFIX = 'lv-collection:';

/** `null` is the vault's way of saying "in no collection". */
export function collectionDropId(collectionId) {
  return `${COLLECTION_PREFIX}${collectionId ?? UNCATEGORISED}`;
}

/**
 * The collection a drop id names, ready to be sent as a patch: an id, or `null`
 * for uncategorised. Returns `undefined` when the id is not a collection at
 * all, which is how the caller tells a bin drop from a move.
 */
export function collectionIdFromDrop(dropId) {
  const id = String(dropId);
  if (!id.startsWith(COLLECTION_PREFIX)) return undefined;

  const value = id.slice(COLLECTION_PREFIX.length);
  return value === UNCATEGORISED ? null : value;
}
