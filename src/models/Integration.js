import mongoose from 'mongoose';

const integrationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      required: true,
      enum: ['google'],
      index: true,
    },
    /** AES-GCM ciphertext — never store raw OAuth tokens. */
    accessTokenEnc: { type: String, default: null },
    refreshTokenEnc: { type: String, default: null },
    scopes: { type: [String], default: [] },
    externalAccountId: { type: String, default: null },
    email: { type: String, default: null },
    status: {
      type: String,
      enum: ['connected', 'error', 'revoked'],
      default: 'connected',
    },
    lastError: { type: String, default: null },
    /** provider-specific extras (e.g. calendarId) */
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

integrationSchema.index({ user: 1, provider: 1 }, { unique: true });

const Integration = mongoose.model('Integration', integrationSchema);

export default Integration;
