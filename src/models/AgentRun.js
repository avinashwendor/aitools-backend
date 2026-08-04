import mongoose from 'mongoose';

/**
 * One execution of an agentic workflow.
 *
 * This document is written *during* the run, not after it. Every status change
 * is persisted as it happens, which is what makes a run observable when the
 * process handling it dies: a run stuck at `running` with three `done` steps
 * tells you exactly where it stopped, whereas a document written only on
 * completion would simply never appear.
 *
 * It also carries both billing numbers per step — credits charged to the user
 * and provider cost in paise — for the same reason the chat ledger does. A run
 * that costs us ₹40 in browser time and charges 60 credits is a fact you want
 * before the invoice, not after.
 */

const stepSchema = new mongoose.Schema(
  {
    nodeId: { type: String, required: true },
    /** Registry type, denormalized so the console can render icons without the graph. */
    type: { type: String, required: true },
    title: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'running', 'done', 'failed', 'skipped'],
      default: 'pending',
    },
    startedAt: { type: Date, default: null },
    durationMs: { type: Number, default: 0 },
    /**
     * What the executor returned. Capped by the runner before it lands here —
     * an extract node pointed at a large page can produce megabytes, and a run
     * document that exceeds Mongo's 16MB limit fails at the moment it matters
     * most, which is when something has gone wrong.
     */
    output: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
    credits: { type: Number, default: 0 },
    /** Provider cost attributable to this step, in paise. */
    costPaise: { type: Number, default: 0 },
  },
  { _id: false }
);

const logSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    level: { type: String, enum: ['info', 'warn', 'error'], default: 'info' },
    nodeId: { type: String, default: null },
    message: { type: String, required: true, maxlength: 2000 },
  },
  { _id: false }
);

const agentRunSchema = new mongoose.Schema(
  {
    workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'AgentWorkflow', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Graph version executed — lets a stored run be replayed against its own shape. */
    workflowVersion: { type: Number, default: 1 },
    workflowName: { type: String, default: '' },
    surface: { type: String, default: 'flow' },

    status: {
      type: String,
      enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'],
      default: 'queued',
      index: true,
    },

    trigger: {
      type: { type: String, default: 'manual' },
      payload: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    },

    steps: { type: [stepSchema], default: [] },
    logs: { type: [logSchema], default: [] },

    /** The final node's output, or the whole scope for a fan-out graph. */
    output: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
    /** Node the run died on, so the canvas can highlight it directly. */
    failedNodeId: { type: String, default: null },

    credits: {
      /** Flat per-run fee. Charged even on failure — the work was attempted. */
      base: { type: Number, default: 0 },
      /** Sum of per-node charges for steps that completed. */
      nodes: { type: Number, default: 0 },
      /** Browser wall-clock, rounded up to the minute. */
      browser: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },

    /** Mirrors the UsageLedger shape so margin math is one aggregation. */
    cost: {
      llmPaise: { type: Number, default: 0 },
      searchPaise: { type: Number, default: 0 },
      browserPaise: { type: Number, default: 0 },
      totalPaise: { type: Number, default: 0 },
    },
    tokens: {
      prompt: { type: Number, default: 0 },
      completion: { type: Number, default: 0 },
    },

    browser: {
      used: { type: Boolean, default: false },
      /** 'browserbase' | 'cdp' — which provider served this run. */
      provider: { type: String, default: null },
      sessionId: { type: String, default: null },
      /**
       * Embeddable URL showing the session as it happens. Only the hosted
       * provider offers one, and only while the session is open — it is stored
       * rather than fetched on demand because by the time anyone opens an old
       * run, the URL is dead and refetching it would just fail slowly.
       */
      liveViewUrl: { type: String, default: null },
      /** Seconds the Chrome session was held open, the billable quantity. */
      seconds: { type: Number, default: 0 },
      /** Screenshots captured during the run, newest last. */
      screenshots: { type: [String], default: [] },
    },

    /** Ledger row this run was charged against, for reconciliation. */
    ledgerId: { type: mongoose.Schema.Types.ObjectId, default: null },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

agentRunSchema.index({ workflow: 1, createdAt: -1 });
agentRunSchema.index({ user: 1, createdAt: -1 });

/**
 * Runs age out after 90 days.
 *
 * They are debugging material, not records of account: the credit charge lives
 * in `UsageLedger`, which is kept for 400 days, so expiring runs loses history
 * you'd want but no money you'd need to explain.
 */
agentRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

agentRunSchema.methods.toJSONSafe = function toJSONSafe() {
  return {
    id: String(this._id),
    workflowId: String(this.workflow),
    workflowName: this.workflowName,
    surface: this.surface,
    status: this.status,
    trigger: this.trigger,
    steps: this.steps,
    logs: this.logs,
    output: this.output,
    error: this.error,
    failedNodeId: this.failedNodeId,
    credits: this.credits,
    browser: {
      used: this.browser?.used,
      provider: this.browser?.provider,
      sessionId: this.browser?.sessionId,
      liveViewUrl: this.browser?.liveViewUrl,
      seconds: this.browser?.seconds,
      screenshots: this.browser?.screenshots || [],
    },
    startedAt: this.startedAt,
    finishedAt: this.finishedAt,
    createdAt: this.createdAt,
  };
};

const AgentRun = mongoose.model('AgentRun', agentRunSchema);

export default AgentRun;
