import mongoose from 'mongoose';

/**
 * A long-lived credential for a client that cannot hold a cookie.
 *
 * The browser extension is the reason this exists. Its popup runs on
 * `chrome-extension://`, which is cross-site to the API, so the `sameSite:
 * 'lax'` session cookie is never attached. The alternative -- loosening the
 * cookie to `sameSite: 'none'` -- would weaken the web app's posture to serve a
 * different client, which is the wrong trade (deployment plan, §10).
 *
 * Only the hash is stored. The token itself is returned exactly once, at
 * creation, and is unrecoverable afterwards; a database dump therefore grants
 * nobody a session.
 */
const apiTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    /** So a user with several clients can revoke the right one. */
    name: { type: String, required: true, trim: true, maxlength: 60 },

    /**
     * SHA-256 of the token, hex encoded.
     *
     * Deliberately a fast hash rather than bcrypt, and the reasoning is the
     * opposite of the one that governs passwords. A password is low-entropy and
     * chosen by a person, so the slow hash is what makes an offline guessing
     * attack impractical. This token is 32 bytes from a CSPRNG -- there is
     * nothing to guess, so the work factor buys no security. What it would cost
     * is the lookup: an unguessable-but-slow hash cannot be indexed, so
     * authenticating one request would mean bcrypt-comparing every token in the
     * collection. This way it is a single indexed equality match.
     */
    tokenHash: { type: String, required: true, unique: true, index: true },

    /**
     * Written at most once a day, not on every request. The point of the field
     * is to let someone recognise a stale credential before revoking it, and
     * that does not need minute precision -- while a write per request would
     * add a database round trip to every call the extension makes.
     */
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } },
);

apiTokenSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    lastUsedAt: this.lastUsedAt,
    createdAt: this.createdAt,
  };
};

export const ApiToken = mongoose.model('ApiToken', apiTokenSchema);
