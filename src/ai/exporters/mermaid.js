/**
 * Mermaid.js diagram exporter for generated workflows.
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

function escapeLabel(str) {
  return String(str || '')
    .replace(/"/g, "'")
    .replace(/[\n\r]+/g, ' ')
    .trim();
}

/**
 * @param {object} workflow assembled workflow
 * @param {object} [options]
 * @param {'TD'|'LR'} [options.direction='TD']
 * @returns {string} Mermaid diagram code string
 */
export function toMermaid(workflow, { direction = 'TD' } = {}) {
  if (!workflow || !Array.isArray(workflow.stages) || workflow.stages.length === 0) {
    throw new Error('Workflow has no stages to export');
  }

  const lines = [
    `graph ${direction}`,
    `  Start(["🚀 ${escapeLabel(workflow.title || 'Workflow')}"])`,
  ];

  const stages = workflow.stages;
  let prevNodeId = 'Start';

  stages.forEach((stage, index) => {
    const nodeId = `Stage_${index + 1}`;
    const toolName = stage.tool?.name || stage.toolSlug || 'Tool';
    const label = `${index + 1}. ${escapeLabel(stage.title || toolName)} (${escapeLabel(toolName)})`;

    lines.push(`  ${nodeId}["${label}"]`);
    lines.push(`  ${prevNodeId} --> ${nodeId}`);

    prevNodeId = nodeId;
  });

  const outcomeLabel = escapeLabel(workflow.outcome || 'Workflow Complete');
  lines.push(`  Finish(["✅ ${outcomeLabel}"])`);
  lines.push(`  ${prevNodeId} --> Finish`);

  return lines.join('\n');
}

export function mermaidFilename(workflow) {
  return `${sanitizeFilename(workflow?.title)}.mmd`;
}

export default { toMermaid, mermaidFilename };
