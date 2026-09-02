import mongoose from 'mongoose';

/**
 * `mongoose.Types.ObjectId.isValid` also accepts any 12-character string, which
 * would let `/links/abcdefghijkl` cast to something real. Round-tripping the
 * value rejects anything that is not a true 24-character hex id.
 */
export function isObjectId(value) {
  const asString = String(value ?? '');
  if (!mongoose.Types.ObjectId.isValid(asString)) return false;
  return new mongoose.Types.ObjectId(asString).toHexString() === asString.toLowerCase();
}
