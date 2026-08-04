/**
 * n8n + markdown exporter unit tests — no Mongo, no LLM.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toN8nWorkflow, n8nFilename } from '../src/ai/exporters/n8n.js';
import { toMarkdown, markdownFilename } from '../src/ai/exporters/markdown.js';

const fixture = {
  id: 'wf_test',
  title: 'Launch a newsletter',
  summary: 'Pick tools and write the first issue.',
  outcome: 'A published newsletter',
  difficulty: 'beginner',
  totalDuration: '~2 hours',
  costSummary: 'Free tier',
  stages: [
    {
      id: 'stage-1',
      title: 'Write the draft',
      toolSlug: 'chatgpt',
      tool: { name: 'ChatGPT', websiteUrl: 'https://chatgpt.com', slug: 'chatgpt' },
      why: 'Fast first draft',
      input: 'Topic brief',
      output: 'Draft copy',
      timeMinutes: 30,
      steps: [
        { title: 'Open ChatGPT', detail: 'Start a new chat' },
        { title: 'Paste the brief', detail: 'Use the prompt below' },
      ],
      prompt: 'Write a newsletter intro about {topic}',
      pitfall: 'Do not invent stats',
      checkpoint: 'Draft reads cleanly aloud',
    },
    {
      id: 'stage-2',
      title: 'Design the layout',
      toolSlug: 'canva',
      tool: { name: 'Canva', websiteUrl: 'https://canva.com', slug: 'canva' },
      why: 'Visual polish',
      input: 'Draft copy',
      output: 'Designed issue',
      timeMinutes: 45,
      steps: [{ title: 'Pick a template', detail: 'Newsletter layout' }],
      settings: [{ label: 'Size', value: 'A4' }],
    },
    {
      id: 'stage-3',
      title: 'Manual review',
      toolSlug: 'notion',
      tool: { name: 'Notion', slug: 'notion' },
      why: 'No public API hop needed for review',
      steps: [{ title: 'Paste and review', detail: 'Check tone' }],
    },
  ],
  tips: ['Send to one friend first'],
};

describe('toN8nWorkflow', () => {
  test('emits trigger, sticky notes, NoOp spine, and HTTP only when websiteUrl exists', () => {
    const n8n = toN8nWorkflow(fixture);

    assert.equal(n8n.name, 'Launch a newsletter');
    assert.ok(Array.isArray(n8n.nodes));
    assert.ok(n8n.connections);

    const types = n8n.nodes.map(n => n.type);
    assert.ok(types.includes('n8n-nodes-base.manualTrigger'));
    assert.ok(types.includes('n8n-nodes-base.stickyNote'));
    assert.ok(types.includes('n8n-nodes-base.noOp'));
    assert.ok(types.includes('n8n-nodes-base.httpRequest'));

    const httpNodes = n8n.nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest');
    assert.equal(httpNodes.length, 2);
    assert.equal(httpNodes[0].parameters.url, 'https://chatgpt.com');

    const trigger = n8n.nodes.find(n => n.type === 'n8n-nodes-base.manualTrigger');
    assert.ok(n8n.connections[trigger.name]);
    assert.equal(n8n.connections[trigger.name].main[0][0].node, '1. Write the draft');

    // Spine continues stage 1 → stage 2
    const stage1Links = n8n.connections['1. Write the draft'].main[0].map(c => c.node);
    assert.ok(stage1Links.includes('2. Design the layout'));

    assert.match(n8nFilename(fixture), /launch-a-newsletter-n8n\.json/);
  });

  test('rejects empty workflows', () => {
    assert.throws(() => toN8nWorkflow({ title: 'x', stages: [] }), /no stages/);
  });
});

describe('toMarkdown', () => {
  test('includes stages, prompt, and tips', () => {
    const md = toMarkdown(fixture);
    assert.match(md, /# Launch a newsletter/);
    assert.match(md, /Write the draft/);
    assert.match(md, /Paste-ready prompt|### Prompt/);
    assert.match(md, /Send to one friend first/);
    assert.match(markdownFilename(fixture), /\.md$/);
  });
});
