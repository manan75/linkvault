import mongoose from 'mongoose';

/**
 * One counter per metered thing per day.
 *
 * In MongoDB rather than in the rate limit store, and that is the entire point
 * of the model existing. The in-memory store loses its counters whenever the
 * process restarts, which on a free instance that spins down after fifteen idle
 * minutes is routine -- and a spending ceiling that resets whenever the app is
 * quiet is not a ceiling at all. A counter that bounds money has to be as
 * durable as the money is.
 *
 * `_id` is the composite key (`enrichment:2026-09-02`) rather than a generated
 * id with a unique index beside it. That makes the conditional increment in
 * `services/usage.js` a single atomic upsert with no second lookup, and it
 * makes the document trivially inspectable from the shell during an incident.
 */
const dailyUsageSchema = new mongoose.Schema(
  {
    _id: { type: String },
    count: { type: Number, default: 0, min: 0 },
    // Lets old counters be swept without parsing the key, and gives an incident
    // a timestamp to reason from.
    day: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

export const DailyUsage = mongoose.model('DailyUsage', dailyUsageSchema);
