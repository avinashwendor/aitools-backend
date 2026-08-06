/**
 * Convert a generated workflow into a Make.com (Integromat) scenario blueprint.
 */

function sanitizeFilename(title) {
  return (
    String(title || 'workflow')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'workflow'
  );
}

/**
 * @param {object} workflow assembled workflow
 * @returns {object} Make.com blueprint JSON object
 */
export function toMakeWorkflow(workflow) {
  if (!workflow || !Array.isArray(workflow.stages) || workflow.stages.length === 0) {
    throw new Error('Workflow has no stages to export');
  }

  const name = String(workflow.title || 'AI Tools workflow').slice(0, 128);
  const stages = workflow.stages;

  const flow = stages.map((stage, index) => {
    const toolName = stage.tool?.name || stage.toolSlug || `Stage ${index + 1}`;
    const websiteUrl = stage.tool?.websiteUrl || '';

    return {
      id: index + 1,
      module: websiteUrl ? 'http:ActionMakeRequest' : 'json:ParseJSON',
      version: 1,
      parameters: {},
      filter: null,
      mapper: {
        url: websiteUrl || undefined,
        method: 'GET',
        stageTitle: stage.title || toolName,
        toolName,
        why: stage.why || '',
        input: stage.input || '',
        output: stage.output || '',
        steps: (stage.steps || []).map(s => s.title || s),
        prompt: stage.prompt || '',
      },
      metadata: {
        designer: {
          x: index * 250,
          y: 0,
          name: `${index + 1}. ${stage.title || toolName}`,
        },
        restore: {},
      },
    };
  });

  return {
    name,
    flow,
    metadata: {
      instant: false,
      version: 1,
      scenario: {
        roundtrips: 1,
        maxErrors: 3,
        autoCommit: true,
        sequential: true,
        confirms: false,
      },
      aiToolsExport: {
        workflowId: workflow.id || null,
        exportedAt: new Date().toISOString(),
        stageCount: stages.length,
      },
    },
  };
}

export function makeFilename(workflow) {
  return `${sanitizeFilename(workflow?.title)}-make.json`;
}

export default { toMakeWorkflow, makeFilename };
