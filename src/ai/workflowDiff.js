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
/**
 * Align each stage of a new plan to the prior stage it continues, if any.
 *
 * Matching runs as ordered passes over the *whole* next-stage list, rather
 * than resolving each next-stage greedily in isolation. A single greedy
 * pass processes stages left to right, so when a stage is inserted midway
 * through the plan, the inserted stage gets resolved before the real stage
 * that used to sit at its new index does — and a same-position fallback
 * would let the inserted stage steal that later stage's identity before
 * the correct title match ever gets a chance to run. Doing title-matching
 * as its own global pass first means position never gets to arbitrate a
 * case it's wrong about.
 *
 * Every prior stage can be claimed by at most one next stage. Two
 * next-stages that both moved away from the same tool (e.g. a global
 * "replace Figma" adjustment touching several stages) must NOT both
 * resolve to the same prior stage — a duplicate id downstream collapses
 * two nodes onto one in the canvas graph and onto one `stageId` in the
 * task board, which is exactly the "connections broke" / "tasks didn't
 * update" reports.
 *
 * Exported because playbook reuse needs the *same* answer this does. They used
 * to disagree: reuse matched by array index while this matched by title, so a
 * refine that inserted or reordered a stage could copy one stage's playbook
 * onto a stage that then took a different stage's identity.
 *
 * @returns {Array<object|null>} parallel to `nextStages`
 */
export function resolveStageMatches(priorStages = [], nextStages = [], adjustment = '') {
  const adjustmentLower = String(adjustment).toLowerCase();
  const norm = s => String(s || '').toLowerCase();

  const claimed = new Set();
  const matches = new Array(nextStages.length).fill(null);
  const assign = (i, priorStage) => { matches[i] = priorStage; claimed.add(priorStage.id); };

  // Pass 1: exact title match anywhere in the prior plan — the strongest,
  // position-independent signal that two stages are "the same step".
  nextStages.forEach((stage, i) => {
    const hit = priorStages.find(ps => !claimed.has(ps.id) && norm(ps.title) === norm(stage.title));
    if (hit) assign(i, hit);
  });

  // Pass 2: same position and same tool — the ordinary no-op-refine case
  // where wording changed slightly but the stage didn't move.
  nextStages.forEach((stage, i) => {
    if (matches[i]) return;
    const atIndex = priorStages[i];
    if (atIndex && !claimed.has(atIndex.id) && atIndex.toolSlug === stage.toolSlug) assign(i, atIndex);
  });

  // Pass 3: the adjustment names the tool being replaced ("replace
  // ElevenLabs with Play.ht") — a same-position tool swap.
  nextStages.forEach((stage, i) => {
    if (matches[i]) return;
    const hit = priorStages.find(ps =>
      !claimed.has(ps.id) &&
      (adjustmentLower.includes(norm(ps.tool?.name) || ' ') ||
        adjustmentLower.includes(String(ps.toolSlug || '').replace(/-/g, ' ')))
    );
    if (hit) assign(i, hit);
  });

  // Pass 4: whatever prior stage is still sitting at the same position —
  // last resort, only reliable when the stage count didn't change.
  nextStages.forEach((stage, i) => {
    if (matches[i]) return;
    const atIndex = priorStages[i];
    if (atIndex && !claimed.has(atIndex.id)) assign(i, atIndex);
  });

  return matches;
}

export function patchWorkflow(prior, next, { adjustment = '' } = {}) {
  if (!prior?.stages?.length) {
    return {
      workflow: { ...next, version: 1 },
      diff: { isNew: true, changedStageIds: [], preservedStageIds: [], replacedTools: [] },
    };
  }

  const priorStages = prior.stages || [];
  const nextStages = next.stages || [];

  const matches = resolveStageMatches(priorStages, nextStages, adjustment);

  const usedIds = new Set(matches.filter(Boolean).map(m => m.id));
  const changedStageIds = [];
  const preservedStageIds = [];
  const replacedTools = [];

  const mergedStages = nextStages.map((stage, index) => {
    const priorStage = matches[index];

    if (!priorStage) {
      // Genuinely new stage (the plan grew). Guard the freshly generated id
      // against colliding with a not-yet-claimed prior id or an id already
      // placed earlier in this same merge — either would reproduce the same
      // duplicate-id corruption the claim tracking above prevents.
      let id = stage.id;
      while (usedIds.has(id)) id = `${stage.id}-${Math.random().toString(36).slice(2, 6)}`;
      usedIds.add(id);
      changedStageIds.push(id);
      return { ...stage, id };
    }

    const sameTool = priorStage.toolSlug === stage.toolSlug;
    const sameOutput = priorStage.output === stage.output;
    // A degraded playbook is the deterministic template, not a written one.
    // Counting it as "has a playbook" is what let a stage that failed to
    // generate once keep that template through every subsequent refine —
    // the one path that would have naturally retried it was the one skipping
    // it as already done.
    const hasPlaybook = Boolean(priorStage.steps?.length) && !priorStage.degraded;
    const unchanged = sameTool && sameOutput && hasPlaybook;

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
        degraded: priorStage.degraded || false,
        // Selection highlights saved via /chat/stage-highlight point at exact
        // substrings of THIS content — carried forward only when the content
        // didn't change, same as steps/prompt above. A changed stage drops
        // them because the phrase they were pinned to may no longer exist.
        highlights: priorStage.highlights,
      };
    }

    changedStageIds.push(priorStage.id);

    if (!sameTool) {
      replacedTools.push({
        stageId: priorStage.id,
        from: { slug: priorStage.toolSlug, name: priorStage.tool?.name },
        to: { slug: stage.toolSlug, name: stage.tool?.name },
      });
    }

    return { ...stage, id: priorStage.id };
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

export default { patchWorkflow, resolveStageMatches };
