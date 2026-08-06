import test from 'node:test';
import assert from 'node:assert/strict';
import { exportWorkflow, markdown, n8n, make, mermaid, script } from '../src/ai/exporters/index.js';

const mockWorkflow = {
  id: 'wf_123',
  title: 'YouTube Video Production',
  summary: 'Create and publish a video from script to thumbnail',
  outcome: 'Published YouTube video',
  totalDuration: '~120 min',
  costSummary: 'Free tools',
  difficulty: 'Beginner',
  stages: [
    {
      id: 'stg_1',
      title: 'Scripting & Topic Research',
      toolSlug: 'chatgpt',
      tool: { name: 'ChatGPT', websiteUrl: 'https://chatgpt.com' },
      why: 'Generates structured script',
      input: 'Video idea',
      output: 'Full video script',
      timeMinutes: 30,
      steps: [{ title: 'Write outline', detail: 'Generate 5 main bullet points' }],
      prompt: 'Write a script for YouTube about AI coding',
    },
    {
      id: 'stg_2',
      title: 'Voiceover Recording',
      toolSlug: 'elevenlabs',
      tool: { name: 'ElevenLabs', websiteUrl: 'https://elevenlabs.io' },
      why: 'Realistic AI voice synthesis',
      input: 'Script',
      output: 'MP3 voiceover track',
      timeMinutes: 15,
      steps: [{ title: 'Synthesize voice', detail: 'Paste script into ElevenLabs' }],
    },
  ],
  tips: ['Review audio quality before editing', 'Add background music'],
};

test('exporters - markdown export', () => {
  const md = markdown.toMarkdown(mockWorkflow);
  assert.ok(md.includes('# YouTube Video Production'));
  assert.ok(md.includes('## 1. Scripting & Topic Research'));
  assert.ok(md.includes('ChatGPT'));
  assert.equal(markdown.markdownFilename(mockWorkflow), 'youtube-video-production.md');
});

test('exporters - n8n export', () => {
  const n8nData = n8n.toN8nWorkflow(mockWorkflow);
  assert.equal(n8nData.name, 'YouTube Video Production');
  assert.ok(Array.isArray(n8nData.nodes));
  assert.ok(n8nData.nodes.some(n => n.type === 'n8n-nodes-base.manualTrigger'));
  assert.equal(n8n.n8nFilename(mockWorkflow), 'youtube-video-production-n8n.json');
});

test('exporters - make.com export', () => {
  const makeData = make.toMakeWorkflow(mockWorkflow);
  assert.equal(makeData.name, 'YouTube Video Production');
  assert.equal(makeData.flow.length, 2);
  assert.equal(make.makeFilename(mockWorkflow), 'youtube-video-production-make.json');
});

test('exporters - mermaid export', () => {
  const mmd = mermaid.toMermaid(mockWorkflow);
  assert.ok(mmd.includes('graph TD'));
  assert.ok(mmd.includes('Scripting & Topic Research'));
  assert.ok(mmd.includes('Finish(["✅ Published YouTube video"])'));
  assert.equal(mermaid.mermaidFilename(mockWorkflow), 'youtube-video-production.mmd');
});

test('exporters - executable script export', () => {
  const scriptContent = script.toScript(mockWorkflow);
  assert.ok(scriptContent.includes('#!/usr/bin/env node'));
  assert.ok(scriptContent.includes('YouTube Video Production'));
  assert.ok(scriptContent.includes('ChatGPT'));
  assert.equal(script.scriptFilename(mockWorkflow), 'youtube-video-production-runner.js');
});

test('exporters - central index function', () => {
  const resMd = exportWorkflow(mockWorkflow, 'markdown');
  assert.equal(resMd.mimeType, 'text/markdown');
  
  const resMake = exportWorkflow(mockWorkflow, 'make');
  assert.equal(resMake.mimeType, 'application/json');

  const resMermaid = exportWorkflow(mockWorkflow, 'mermaid');
  assert.equal(resMermaid.mimeType, 'text/plain');

  const resScript = exportWorkflow(mockWorkflow, 'script');
  assert.equal(resScript.mimeType, 'text/javascript');
});
