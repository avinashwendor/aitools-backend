/**
 * Surgical workflow patching.
 *
 * On a refine turn the planner may return a full new plan, but most stages are
 * unchanged. This merges the new plan into the prior workflow JSON — stable
 * workflow.id, stable stage ids where possible, preserved playbooks — instead
 * of throwing away the graph the user was already working on.
 */

/**
 * @param {object|null} prior
 * @param {object} next freshly assembled workflow
 * @param {object} [opts]
 * @param {string} [opts.adjustment] user's refinement request
 * @returns {{ workflow: object, diff: object }}
 */
export function patchWorkflow(prior, next, { adjustment = '' } = {}) {
  if (!prior?.stages?.length) {
    return {
      workflow: { ...next, version: 1 },
      diff: { isNew: true, changedStageIds: [], preservedStageIds: [], replacedTools: [] },
    };
  }

  const priorStages = prior.stages || [];
  const nextStages = next.stages || [];
  const adjustmentLower = String(adjustment).toLowerCase();

  const priorBySlug = new Map(priorStages.map(s => [s.toolSlug, s]));
  const priorByTitle = new Map(priorStages.map(s => [String(s.title || '').toLowerCase(), s]));

  const changedStageIds = [];
  const preservedStageIds = [];
  const replacedTools = [];

  const mergedStages = nextStages.map((stage, index) => {
    const priorAtIndex = priorStages[index];
    let priorStage = priorAtIndex;

    // Tool-swap refinements ("replace ElevenLabs") — match the stage being replaced.
    if (priorAtIndex && priorAtIndex.toolSlug !== stage.toolSlug) {
      const mentionedPrior = priorStages.find(ps =>
        adjustmentLower.includes(ps.tool?.name?.toLowerCase() || '') ||
        adjustmentLower.includes(ps.toolSlug.replace(/-/g, ' '))
      );
      if (mentionedPrior) priorStage = mentionedPrior;
    }

    const sameTool = priorStage?.toolSlug === stage.toolSlug;
    const sameTitle = priorStage && String(priorStage.title).toLowerCase() === String(stage.title).toLowerCase();
    const sameOutput = priorStage?.output === stage.output;
    const hasPlaybook = Boolean(priorStage?.steps?.length);

    const unchanged = priorStage && sameTool && sameOutput && hasPlaybook;

    if (unchanged) {
      preservedStageIds.push(priorStage.id);
      return {
        ...stage,
        id: priorStage.id,
        steps: priorStage.steps,
        prompt: priorStage.prompt,
        settings: priorStage.settings,
        pitfall: priorStage.pitfall,
        checkpoint: priorStage.checkpoint,
      };
    }

    const stageId = priorStage?.id || stage.id;
    changedStageIds.push(stageId);

    if (priorStage && priorStage.toolSlug !== stage.toolSlug) {
      replacedTools.push({
        stageId,
        from: { slug: priorStage.toolSlug, name: priorStage.tool?.name },
        to: { slug: stage.toolSlug, name: stage.tool?.name },
      });
    }

    return { ...stage, id: stageId };
  });

  const workflow = {
    ...next,
    id: prior.id,
    version: (prior.version || 1) + 1,
    stages: mergedStages,
    meta: {
      ...next.meta,
      patched: true,
      priorVersion: prior.version || 1,
      preservedStages: preservedStageIds.length,
      changedStages: changedStageIds.length,
    },
  };

  workflow.reply = next.reply;

  return {
    workflow,
    diff: {
      isNew: false,
      changedStageIds,
      preservedStageIds,
      replacedTools,
      changedCount: changedStageIds.length,
      preservedCount: preservedStageIds.length,
    },
  };
}

export default { patchWorkflow };
