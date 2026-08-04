/**
 * Markdown export of a generated workflow — human-readable companion to n8n.
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
 * @param {object} workflow assembled lastWorkflow
 * @returns {string}
 */
export function toMarkdown(workflow) {
  if (!workflow || !Array.isArray(workflow.stages) || workflow.stages.length === 0) {
    throw new Error('Workflow has no stages to export');
  }

  const lines = [
    `# ${workflow.title || 'Workflow'}`,
    '',
  ];

  if (workflow.summary) lines.push(workflow.summary, '');
  if (workflow.outcome) lines.push(`**Outcome:** ${workflow.outcome}`, '');

  const meta = [];
  if (workflow.totalDuration) meta.push(`Duration: ${workflow.totalDuration}`);
  if (workflow.costSummary) meta.push(`Cost: ${workflow.costSummary}`);
  if (workflow.difficulty) meta.push(`Difficulty: ${workflow.difficulty}`);
  if (meta.length) lines.push(meta.join(' · '), '');

  workflow.stages.forEach((stage, index) => {
    const toolName = stage.tool?.name || stage.toolSlug || 'Tool';
    const website = stage.tool?.websiteUrl;
    lines.push(`## ${index + 1}. ${stage.title || toolName}`, '');
    lines.push(`**Tool:** ${toolName}${website ? ` ([site](${website}))` : ''}`, '');
    if (stage.why) lines.push(`**Why:** ${stage.why}`, '');
    if (stage.input) lines.push(`**Input:** ${stage.input}`, '');
    if (stage.output) lines.push(`**Output:** ${stage.output}`, '');
    if (stage.timeMinutes) lines.push(`**Est. time:** ~${stage.timeMinutes} min`, '');

    const steps = Array.isArray(stage.steps) ? stage.steps : [];
    if (steps.length) {
      lines.push('### Steps', '');
      steps.forEach((s, i) => {
        lines.push(`${i + 1}. **${s.title || `Step ${i + 1}`}**`);
        if (s.detail) lines.push(`   ${s.detail}`);
      });
      lines.push('');
    }

    if (stage.prompt) {
      lines.push('### Prompt', '', '```', stage.prompt, '```', '');
    }

    if (Array.isArray(stage.settings) && stage.settings.length) {
      lines.push('### Settings', '');
      stage.settings.forEach(row => lines.push(`- **${row.label}:** ${row.value}`));
      lines.push('');
    }

    if (stage.pitfall) lines.push(`**Watch out:** ${stage.pitfall}`, '');
    if (stage.checkpoint) lines.push(`**Checkpoint:** ${stage.checkpoint}`, '');
  });

  if (Array.isArray(workflow.tips) && workflow.tips.length) {
    lines.push('## Tips', '');
    workflow.tips.forEach(t => lines.push(`- ${t}`));
    lines.push('');
  }

  lines.push('---', '', '_Exported from AI Tools_', '');
  return lines.join('\n');
}

export function markdownFilename(workflow) {
  return `${sanitizeFilename(workflow?.title)}.md`;
}

export default { toMarkdown, markdownFilename };
