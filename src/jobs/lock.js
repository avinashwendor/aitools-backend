/**
 * Cross-replica advisory lock via MongoDB.
 * Used when REDIS_URL is unset so only one instance runs hourly reminder scans.
 */

import mongoose from 'mongoose';

const lockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    holder: { type: String, default: '' },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

lockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const JobLock = mongoose.models.JobLock || mongoose.model('JobLock', lockSchema);

/**
 * @param {string} name
 * @param {number} ttlMs how long the lock is held
 * @returns {Promise<boolean>} true if this process acquired the lock
 */
export async function tryAcquireLock(name, ttlMs) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const holder =
    process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || `pid-${process.pid}`;

  const taken = await JobLock.findOneAndUpdate(
    { _id: name, expiresAt: { $lte: now } },
    { $set: { holder, expiresAt } },
    { new: true }
  );
  if (taken) return true;

  try {
    await JobLock.create({ _id: name, holder, expiresAt });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

export default { tryAcquireLock };
