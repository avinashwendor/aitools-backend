/**
 * Public snapshot of a generated workflow — growth loop + citeable pages.
 * Stores a stripped copy so later edits to the private session don't rewrite
 * what was shared.
 */

import mongoose from 'mongoose';
import crypto from 'crypto';
import slugify from 'slugify';

const sharedWorkflowSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
      trim: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    sessionId: {
      type: String,
      required: true,
    },
    visibility: {
      type: String,
      enum: ['public', 'unlisted'],
      default: 'public',
    },
    /** Sanitized workflow snapshot (no meta costs / private ids). */
    workflow: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    title: { type: String, default: '' },
    outcome: { type: String, default: '' },
  },
  { timestamps: true }
);

sharedWorkflowSchema.index({ user: 1, sessionId: 1 }, { unique: true });

/** Strip private / billing fields before publishing. */
export function sanitizeWorkflowForShare(workflow) {
  if (!workflow) return null;
  const {
    meta,
    reply,
    ...rest
  } = workflow;

  return {
    id: rest.id,
    title: rest.title,
    summary: rest.summary,
    outcome: rest.outcome,
    difficulty: rest.difficulty,
    totalMinutes: rest.totalMinutes,
    totalDuration: rest.totalDuration,
    costSummary: rest.costSummary,
    tips: rest.tips,
    followUp: rest.followUp,
    createdAt: rest.createdAt,
    stages: (rest.stages || []).map(s => ({
      id: s.id,
      index: s.index,
      title: s.title,
      toolSlug: s.toolSlug,
      tool: s.tool
        ? {
            name: s.tool.name,
            slug: s.tool.slug,
            tagline: s.tool.tagline,
            logo: s.tool.logo,
            websiteUrl: s.tool.websiteUrl,
            pricing: s.tool.pricing,
            category: s.tool.category,
          }
        : null,
      why: s.why,
      input: s.input,
      output: s.output,
      timeMinutes: s.timeMinutes,
      alternatives: s.alternatives,
      steps: s.steps,
      prompt: s.prompt,
      settings: s.settings,
      pitfall: s.pitfall,
      checkpoint: s.checkpoint,
    })),
  };
}

export function makeShareSlug(title) {
  const base =
    slugify(String(title || 'workflow').slice(0, 48), {
      lower: true,
      strict: true,
    }) || 'workflow';
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${base}-${suffix}`;
}

const SharedWorkflow = mongoose.model('SharedWorkflow', sharedWorkflowSchema);

export default SharedWorkflow;
