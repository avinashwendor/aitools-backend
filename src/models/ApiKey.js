/**
 * API keys for MCP / public API access.
 *
 * The raw key is shown once at creation; only a SHA-256 hash is stored.
 * Prefix is kept for display ("ait_…abcd").
 */

import mongoose from 'mongoose';
import crypto from 'crypto';

const KEY_PREFIX = 'ait_';

const apiKeySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      default: 'Default',
    },
    /** SHA-256 hex of the full secret. */
    keyHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    /** First 8 chars after prefix, for UI lists. */
    keyPrefix: {
      type: String,
      required: true,
    },
    scopes: {
      type: [String],
      default: ['mcp'],
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

apiKeySchema.index({ user: 1, revokedAt: 1 });

/** Generate a new raw key + hash pair. Raw is returned only at create time. */
export function generateApiKeySecret() {
  const secret = crypto.randomBytes(32).toString('base64url');
  const raw = `${KEY_PREFIX}${secret}`;
  const keyHash = hashApiKey(raw);
  const keyPrefix = raw.slice(0, KEY_PREFIX.length + 8);
  return { raw, keyHash, keyPrefix };
}

export function hashApiKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

const ApiKey = mongoose.model('ApiKey', apiKeySchema);

export default ApiKey;
