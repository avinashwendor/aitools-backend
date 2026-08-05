import mongoose from 'mongoose';

/**
 * What a workflow has already seen.
 *
 * The smallest possible amount of state, and the piece whose absence made every
 * scheduled workflow subtly useless: a graph that polls a feed on a timer and
 * remembers nothing re-delivers the same items on every tick. The user gets the
 * same ten articles hourly, decides the product does not work, and no amount of
 * better graph-building fixes it, because the missing thing is memory rather
 * than structure.
 *
 * One document per (workflow, scope, item), holding a hash rather than the key
 * itself. The keys are other people's identifiers — order numbers, customer
 * emails, ticket ids — and there is no feature here that needs to read one
 * back. Storing the hash means a database dump is not a list of somebody's
 * customers, and it costs nothing, because the only question ever asked is
 * "have I seen this exact value before".
 *
 * Expiry is per document rather than per collection. How long "already seen"
 * should last is a property of the workflow — a daily digest needs a week, a
 * ticket poller needs a year — so the TTL index watches an `expiresAt` the
 * writer sets, which is the one way Mongo allows a per-row lifetime.
 */
const agentMemorySchema = new mongoose.Schema(
  {
    workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'AgentWorkflow', required: true },
    /**
     * `*` when the whole workflow shares one memory, or a node id when a step
     * keeps its own. Two pollers reading different feeds into the same workflow
     * would otherwise mask each other's items.
     */
    scope: { type: String, required: true, default: '*', maxlength: 60 },
    /** SHA-256 of the key value. See above — we never need the original. */
    keyHash: { type: String, required: true, maxlength: 64 },
    seenAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false }
);

/**
 * The lookup and the uniqueness guarantee in one index.
 *
 * Unique matters under concurrency: two runs of the same workflow overlapping —
 * a schedule firing while a manual run is still going — would otherwise both
 * see an item as new and both deliver it. The insert conflicts instead, and the
 * loser treats the item as already seen, which is the safe direction to be
 * wrong in when the alternative is sending something twice.
 */
agentMemorySchema.index({ workflow: 1, scope: 1, keyHash: 1 }, { unique: true });
agentMemorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const AgentMemory = mongoose.model('AgentMemory', agentMemorySchema);

export default AgentMemory;
