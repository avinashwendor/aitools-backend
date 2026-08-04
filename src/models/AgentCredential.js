import mongoose from 'mongoose';
import { encryptSecret, decryptSecret } from '../integrations/crypto.js';

/**
 * A user-supplied secret a workflow node can use — an API key, a bearer token,
 * a webhook signing secret.
 *
 * Credentials live here rather than in the graph for one reason that decides
 * everything else: a graph is exportable, shareable, composable by a model, and
 * shown in full in an editor. A secret pasted into a node field would leak
 * through every one of those. Nodes carry a credential *id*; the value is
 * fetched, decrypted and used inside the executor, and never travels back to
 * the client — `toJSONSafe` has no branch that can return it.
 *
 * Reuses the same AES-256-GCM helpers as the OAuth integrations, so there is
 * one key to rotate and one encryption path to audit.
 */

const agentCredentialSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 80 },

    /**
     * Which node types may select it. The inspector's credential field declares
     * a `provider`, and the picker filters on this — so an HTTP node can't
     * accidentally offer the user their Slack token.
     */
    provider: {
      type: String,
      required: true,
      enum: ['http', 'openai', 'anthropic', 'slack', 'discord', 'generic'],
      default: 'generic',
    },

    /**
     * How the executor should present it. `bearer` and `header` cover almost
     * every REST API; `raw` hands the value to the executor untouched for the
     * cases that don't fit.
     */
    scheme: {
      type: String,
      enum: ['bearer', 'header', 'query', 'raw'],
      default: 'bearer',
    },

    /** Header or query-parameter name, for the schemes that need one. */
    paramName: { type: String, default: 'Authorization', maxlength: 80 },

    /** AES-256-GCM ciphertext. Never selected by default — see the query hook. */
    secret: { type: String, required: true, select: false },

    /** Last four characters, so the UI can show which key is which. */
    hint: { type: String, default: '' },

    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

agentCredentialSchema.index({ user: 1, provider: 1 });
agentCredentialSchema.index({ user: 1, name: 1 }, { unique: true });

/**
 * Encrypt on assignment.
 *
 * A virtual rather than a pre-save hook: hooks don't run on `findOneAndUpdate`,
 * which is exactly the path an edit takes, and a plaintext secret written by an
 * update that skipped the hook is indistinguishable from a correct one until
 * someone reads the collection.
 */
agentCredentialSchema
  .virtual('plaintext')
  .set(function setPlaintext(value) {
    if (!value) return;
    this.secret = encryptSecret(String(value));
    this.hint = String(value).slice(-4);
  });

/** Decrypt for use inside an executor. Requires an explicitly selected `secret`. */
agentCredentialSchema.methods.reveal = function reveal() {
  if (!this.secret) {
    throw new Error('Credential loaded without its secret — select("+secret") first.');
  }
  return decryptSecret(this.secret);
};

/**
 * Turn a credential into the request decoration its scheme implies.
 * Keeps every executor from re-deriving "bearer means Authorization: Bearer …".
 */
agentCredentialSchema.methods.applyTo = function applyTo({ headers = {}, url = '' } = {}) {
  const value = this.reveal();
  const nextHeaders = { ...headers };
  let nextUrl = url;

  switch (this.scheme) {
    case 'bearer':
      nextHeaders[this.paramName || 'Authorization'] = `Bearer ${value}`;
      break;
    case 'header':
      nextHeaders[this.paramName || 'X-API-Key'] = value;
      break;
    case 'query': {
      const separator = nextUrl.includes('?') ? '&' : '?';
      nextUrl = `${nextUrl}${separator}${encodeURIComponent(this.paramName || 'api_key')}=${encodeURIComponent(value)}`;
      break;
    }
    default:
      break;
  }

  return { headers: nextHeaders, url: nextUrl, value };
};

agentCredentialSchema.methods.toJSONSafe = function toJSONSafe() {
  return {
    id: String(this._id),
    name: this.name,
    provider: this.provider,
    scheme: this.scheme,
    paramName: this.paramName,
    hint: this.hint ? `••••${this.hint}` : '',
    lastUsedAt: this.lastUsedAt,
    createdAt: this.createdAt,
  };
};

const AgentCredential = mongoose.model('AgentCredential', agentCredentialSchema);

export default AgentCredential;
