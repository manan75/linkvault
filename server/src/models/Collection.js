import mongoose from 'mongoose';

const collectionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } },
);

// Two collections called "Reading" and "reading" would be indistinguishable in a
// sidebar, so uniqueness is enforced case-insensitively via collation strength 2.
collectionSchema.index(
  { userId: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } },
);

collectionSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

export const Collection = mongoose.model('Collection', collectionSchema);
