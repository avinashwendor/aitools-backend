/**
 * Convert a generated workflow into an importable n8n workflow JSON.
 *
 * Stages are human playbooks over catalog tools, so the export is honest:
 *   - Manual Trigger starts a NoOp walkthrough chain (one marker per stage)
 *   - Sticky Note per stage carries steps / prompt / pitfall / tool link
 *   - HTTP Request only when the tool has a websiteUrl (open the site — never
 *     invent authenticated API calls)
 */

import { randomUUID } from 'crypto';

const TRIGGER_NAME = "When clicking 'Execute workflow'";

function nodeId() {
  return randomUUID();
}

function sanitizeFilename(title) {
  return (
    String(title || 'workflow')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'workflow'
  );
}

function stageStickyContent(stage, index) {
  const toolName = stage.tool?.name || stage.toolSlug || 'Tool';
  const website = stage.tool?.websiteUrl || '';
  const lines = [
    `## Stage ${index + 1}: ${stage.title || toolName}`,
    '',
    `**Tool:** ${toolName}${website ? ` — ${website}` : ''}`,
  ];

  if (stage.why) lines.push('', `**Why:** ${stage.why}`);
  if (stage.input) lines.push('', `**Input:** ${stage.input}`);
  if (stage.output) lines.push('', `**Output:** ${stage.output}`);
  if (stage.timeMinutes) lines.push('', `**Est. time:** ~${stage.timeMinutes} min`);

  const steps = Array.isArray(stage.steps) ? stage.steps : [];
  if (steps.length) {
    lines.push('', '### Steps');
    steps.forEach((s, i) => {
      lines.push(`${i + 1}. **${s.title || `Step ${i + 1}`}**`);
      if (s.detail) lines.push(`   ${s.detail}`);
    });
  }

  if (stage.prompt) {
    lines.push('', '### Paste-ready prompt', '```', stage.prompt, '```');
  }

  if (Array.isArray(stage.settings) && stage.settings.length) {
    lines.push('', '### Settings');
    stage.settings.forEach(row => {
      lines.push(`- **${row.label}:** ${row.value}`);
    });
  }

  if (stage.pitfall) lines.push('', `**Watch out:** ${stage.pitfall}`);
  if (stage.checkpoint) lines.push('', `**Checkpoint:** ${stage.checkpoint}`);

  lines.push(
    '',
    '> Manual stage — complete this in the tool above, then continue the chain.'
  );

  return lines.join('\n');
}

function stageNoopName(stage, index) {
  const toolName = stage.tool?.name || stage.toolSlug || `Stage ${index + 1}`;
  return `${index + 1}. ${String(stage.title || toolName).slice(0, 40)}`;
}

/**
 * @param {object} workflow assembled lastWorkflow from the engine
 */
export function toN8nWorkflow(workflow) {
  if (!workflow || !Array.isArray(workflow.stages) || workflow.stages.length === 0) {
    throw new Error('Workflow has no stages to export');
  }

  const name = String(workflow.title || 'AI Tools workflow').slice(0, 128);
  const stages = workflow.stages;
  const nodes = [];
  const connections = {};

  nodes.push({
    parameters: {},
    id: nodeId(),
    name: TRIGGER_NAME,
    type: 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    position: [0, 0],
  });

  nodes.push({
    parameters: {
      content: [
        `# ${name}`,
        '',
        workflow.summary || workflow.outcome || '',
        '',
        workflow.costSummary ? `**Cost:** ${workflow.costSummary}` : null,
        workflow.totalDuration ? `**Duration:** ${workflow.totalDuration}` : null,
        workflow.difficulty ? `**Difficulty:** ${workflow.difficulty}` : null,
        '',
        '_Exported from AI Tools — sticky notes document each stage; the NoOp chain is the walkthrough order._',
      ]
        .filter(line => line !== null)
        .join('\n'),
      height: 320,
      width: 420,
      color: 5,
    },
    id: nodeId(),
    name: 'Overview',
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [-480, -80],
  });

  const noopNames = stages.map(stageNoopName);

  stages.forEach((stage, index) => {
    const x = 280 + index * 360;
    const noopName = noopNames[index];
    const toolName = stage.tool?.name || stage.toolSlug || `Stage ${index + 1}`;

    nodes.push({
      parameters: {
        content: stageStickyContent(stage, index),
        height: 480,
        width: 320,
        color: (index % 7) + 1,
      },
      id: nodeId(),
      name: `Note: ${noopName}`,
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [x - 40, 160],
    });

    nodes.push({
      parameters: {},
      id: nodeId(),
      name: noopName,
      type: 'n8n-nodes-base.noOp',
      typeVersion: 1,
      position: [x, 0],
    });

    const websiteUrl = stage.tool?.websiteUrl;
    if (websiteUrl) {
      const httpName = `Open ${String(toolName).slice(0, 28)}`;
      nodes.push({
        parameters: {
          method: 'GET',
          url: websiteUrl,
          options: {},
        },
        id: nodeId(),
        name: httpName,
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        position: [x, -200],
      });
      // Side hop from the stage marker — does not break the NoOp spine below.
      connections[noopName] = {
        main: [[{ node: httpName, type: 'main', index: 0 }]],
      };
    }
  });

  // Linear spine: Trigger → stage1 → stage2 → …
  connections[TRIGGER_NAME] = {
    main: [[{ node: noopNames[0], type: 'main', index: 0 }]],
  };

  for (let i = 0; i < noopNames.length - 1; i++) {
    const from = noopNames[i];
    const to = noopNames[i + 1];
    const side = connections[from]?.main?.[0] || [];
    connections[from] = {
      main: [[...side.filter(c => c.node !== to), { node: to, type: 'main', index: 0 }]],
    };
  }

  return {
    name,
    nodes,
    connections,
    pinData: {},
    meta: {
      templateCredsSetupCompleted: false,
      aiToolsExport: {
        workflowId: workflow.id || null,
        exportedAt: new Date().toISOString(),
        stageCount: stages.length,
      },
    },
    settings: {
      executionOrder: 'v1',
    },
  };
}

export function n8nFilename(workflow) {
  return `${sanitizeFilename(workflow?.title)}-n8n.json`;
}

export default { toN8nWorkflow, n8nFilename };
