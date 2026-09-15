import mongoose from 'mongoose';

/**
 * A message an early user typed into the app.
 *
 * This exists because the alternative -- a `mailto:` link -- loses most of what
 * people would have said. Feedback arrives in the second someone is annoyed,
 * and anything that interrupts that second to open a mail client collects the
 * two most motivated users and silence from everyone else.
 */
const feedbackSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    /*
      Denormalised on purpose, and it is the whole ergonomics of this model.
      These documents are read in the Atlas UI, where a bare ObjectId means a
      second lookup before the owner knows who to reply to. Capturing the
      address *as it was when the message was written* is also the more correct
      thing for feedback specifically: it is who to answer about this message,
      not who the account belongs to today.
    */
    email: {
      type: String,
      required: true,
      trim: true,
    },

    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },

    /*
      Which screen they were on. One short string, and the only context
      collected -- enough to tell "search is broken" from "saving is broken"
      without collecting a session recording to find out.
    */
    path: {
      type: String,
      trim: true,
      maxlength: 200,
      default: '',
    },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } },
);

// The only read this collection gets is "show me everything, newest first".
feedbackSchema.index({ createdAt: -1 });

feedbackSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    message: this.message,
    createdAt: this.createdAt,
  };
};

export const Feedback = mongoose.model('Feedback', feedbackSchema);
