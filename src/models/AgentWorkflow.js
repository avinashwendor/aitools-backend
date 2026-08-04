import mongoose from 'mongoose';
import crypto from 'crypto';

/**
 * An executable workflow — the agentic counterpart to the advisory workflows
 * the chat engine produces.
 *
 * The two are deliberately different documents rather than one with a `type`
 * discriminator. A chat workflow is a *plan* ("use Descript, then Opus Clip"),
 * immutable once generated, stored on the conversation because it only means
 * anything next to the goal that produced it. This is a *program*: it is
 * edited over months, versioned, triggered by the outside world, and it spends
 * money every time it runs. Folding them together would put webhook tokens and
 * run counters on every advisory plan, and force every read of a plan through
 * a graph validator that has nothing to say about it.
 *
 * The graph itself is stored the way React Flow hands it over — nodes with
 * positions, edges with handles — because a canvas that has to reconstruct
 * layout on load will eventually reconstruct it wrong.
 */

const positionSchema = new mongoose.Schema(
  { x: { type: Number, default: 0 }, y: { type: Number, default: 0 } },
  { _id: false }
);

const nodeSchema = new mongoose.Schema(
  {
    /**
     * Author-facing id, e.g. `open_1`. Not a Mongo id on purpose: it is what
     * users type inside `{{ … }}` references, so it has to be short, stable and
     * meaningful. Uniqueness is enforced per-graph by the validator.
     */
    id: { type: String, required: true, maxlength: 60 },
    /** Key into the node registry. Validated on save. */
    type: { type: String, required: true, maxlength: 60 },
    position: { type: positionSchema, default: () => ({ x: 0, y: 0 }) },
    data: {
      /** Display name. Defaults to the registry label, renameable per node. */
      title: { type: String, default: '', maxlength: 120 },
      /**
       * Field values, keyed by the registry field key. Mixed because each node
       * type has its own shape — the registry is the schema, and duplicating it
       * here in Mongoose would give us two schemas to keep in step.
       *
       * Secrets are never stored here. Credential fields hold an id.
       */
      values: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
      /** Author's note, shown on the canvas card. */
      note: { type: String, default: '', maxlength: 500 },
    },
  },
  { _id: false }
);

const edgeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, maxlength: 120 },
    source: { type: String, required: true, maxlength: 60 },
    target: { type: String, required: true, maxlength: 60 },
    /** Which output the edge leaves from — `main`, or `true`/`false` on an If. */
    sourceHandle: { type: String, default: 'main', maxlength: 40 },
    targetHandle: { type: String, default: 'in', maxlength: 40 },
  },
  { _id: false }
);

const agentWorkflowSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 120, default: 'Untitled workflow' },
    description: { type: String, default: '', maxlength: 600 },

    status: {
      type: String,
      enum: ['draft', 'active', 'paused'],
      default: 'draft',
      index: true,
    },

    graph: {
      nodes: { type: [nodeSchema], default: [] },
      edges: { type: [edgeSchema], default: [] },
    },

    /**
     * Bumped on every graph write. A run records the version it executed, so a
     * failed run six weeks ago can be read against the graph as it was, not as
     * it is now — which is the difference between a debuggable history and a
     * misleading one.
     */
    version: { type: Number, default: 1 },

    /** Last validation result, cached so the list view can show badges cheaply. */
    validation: {
      errors: { type: [String], default: [] },
      warnings: { type: [String], default: [] },
      checkedAt: { type: Date, default: null },
    },

    /**
     * Per-workflow webhook secret. Generated once at creation so the URL is
     * stable enough to paste into another service, and rotatable on demand.
     */
    webhookToken: {
      type: String,
      default: () => crypto.randomBytes(24).toString('base64url'),
      index: true,
    },

    schedule: {
      enabled: { type: Boolean, default: false },
      every: { type: String, default: 'day' },
      atHour: { type: Number, default: 9 },
      /**
       * Denormalized so the scheduler can find due workflows with one indexed
       * range query instead of parsing every schedule on every tick.
       */
      nextRunAt: { type: Date, default: null, index: true },
    },

    stats: {
      runs: { type: Number, default: 0 },
      failures: { type: Number, default: 0 },
      creditsSpent: { type: Number, default: 0 },
      lastRunAt: { type: Date, default: null },
      lastStatus: { type: String, default: null },
    },

    /** The original brief, so the editor can show what it was asked for. */
    composedFrom: { type: String, default: '', maxlength: 2000 },

    /**
     * What the architect worked out before it built anything.
     *
     * Kept on the workflow rather than on the build session that produced it,
     * because it stays true after the session ends: six weeks later, "why does
     * this call that endpoint?" is answered by the sources it read, and "what do
     * I need to plug in?" is answered by the requirements — including the ones
     * still unfilled, which is the single most common reason a run fails.
     */
    blueprint: {
      goal: { type: String, default: '', maxlength: 4000 },
      summary: { type: String, default: '', maxlength: 4000 },
      plan: {
        type: [
          new mongoose.Schema(
            {
              title: { type: String, default: '', maxlength: 200 },
              detail: { type: String, default: '', maxlength: 1000 },
            },
            { _id: false }
          ),
        ],
        default: [],
      },
      /** Pages the architect actually read, so a claim can be traced to a source. */
      sources: {
        type: [
          new mongoose.Schema(
            {
              title: { type: String, default: '', maxlength: 300 },
              url: { type: String, default: '', maxlength: 1000 },
              note: { type: String, default: '', maxlength: 600 },
            },
            { _id: false }
          ),
        ],
        default: [],
      },
      builtAt: { type: Date, default: null },
    },

    /**
     * Credentials this workflow needs before it can run.
     *
     * The architect writes these as it discovers them; the editor renders them
     * as a checklist and fills `credentialId` when the user supplies one. A
     * requirement whose id is null is why the Run button is disabled, and
     * saying so is far better than letting the run fail on step four with a 401.
     */
    requirements: {
      type: [
        new mongoose.Schema(
          {
            key: { type: String, required: true, maxlength: 60 },
            label: { type: String, default: '', maxlength: 120 },
            provider: { type: String, default: 'generic', maxlength: 40 },
            /** Plain-language steps for getting the key, written by the architect. */
            instructions: { type: String, default: '', maxlength: 2000 },
            docsUrl: { type: String, default: '', maxlength: 1000 },
            /** Node ids that consume it, so the editor can point at them. */
            usedBy: { type: [String], default: [] },
            credentialId: { type: mongoose.Schema.Types.ObjectId, ref: 'AgentCredential', default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    archivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

agentWorkflowSchema.index({ user: 1, archivedAt: 1, updatedAt: -1 });
agentWorkflowSchema.index({ 'schedule.enabled': 1, 'schedule.nextRunAt': 1 });

/** Public shape — the graph plus everything the editor header needs. */
agentWorkflowSchema.methods.toEditorJSON = function toEditorJSON() {
  return {
    id: String(this._id),
    name: this.name,
    description: this.description,
    status: this.status,
    version: this.version,
    graph: {
      nodes: this.graph.nodes.map(n => ({
        id: n.id,
        type: n.type,
        position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
        data: {
          title: n.data?.title || '',
          values: n.data?.values || {},
          note: n.data?.note || '',
        },
      })),
      edges: this.graph.edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle || 'main',
        targetHandle: e.targetHandle || 'in',
      })),
    },
    validation: this.validation,
    /**
     * Shipped to the editor so it can show the webhook URL to paste elsewhere.
     * Safe to send: it authenticates *inbound calls to this one workflow* and
     * nothing else, it is only ever returned to the workflow's owner, and the
     * owner needs it to be of any use at all.
     */
    webhookToken: this.webhookToken,
    schedule: this.schedule,
    stats: this.stats,
    composedFrom: this.composedFrom,
    blueprint: this.blueprint,
    requirements: (this.requirements || []).map(requirement => ({
      key: requirement.key,
      label: requirement.label,
      provider: requirement.provider,
      instructions: requirement.instructions,
      docsUrl: requirement.docsUrl,
      usedBy: requirement.usedBy,
      credentialId: requirement.credentialId ? String(requirement.credentialId) : null,
      satisfied: Boolean(requirement.credentialId),
    })),
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

/** List shape — never ships the graph; a list of 50 would be megabytes. */
agentWorkflowSchema.methods.toListJSON = function toListJSON() {
  return {
    id: String(this._id),
    name: this.name,
    description: this.description,
    status: this.status,
    nodeCount: this.graph?.nodes?.length || 0,
    hasErrors: (this.validation?.errors?.length || 0) > 0,
    pendingRequirements: (this.requirements || []).filter(r => !r.credentialId).length,
    schedule: { enabled: this.schedule?.enabled, every: this.schedule?.every },
    stats: this.stats,
    updatedAt: this.updatedAt,
  };
};

const AgentWorkflow = mongoose.model('AgentWorkflow', agentWorkflowSchema);

export default AgentWorkflow;
