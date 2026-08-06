/**
 * Central index for all workflow export formats.
 */

import markdown from './markdown.js';
import n8n from './n8n.js';
import make from './make.js';
import mermaid from './mermaid.js';
import script from './script.js';

export {
  markdown,
  n8n,
  make,
  mermaid,
  script,
};

export function exportWorkflow(workflow, format = 'markdown') {
  switch (format.toLowerCase()) {
    case 'n8n':
    case 'json':
      return {
        content: JSON.stringify(n8n.toN8nWorkflow(workflow), null, 2),
        filename: n8n.n8nFilename(workflow),
        mimeType: 'application/json',
      };
    case 'make':
      return {
        content: JSON.stringify(make.toMakeWorkflow(workflow), null, 2),
        filename: make.makeFilename(workflow),
        mimeType: 'application/json',
      };
    case 'mermaid':
      return {
        content: mermaid.toMermaid(workflow),
        filename: mermaid.mermaidFilename(workflow),
        mimeType: 'text/plain',
      };
    case 'script':
    case 'js':
      return {
        content: script.toScript(workflow),
        filename: script.scriptFilename(workflow),
        mimeType: 'text/javascript',
      };
    case 'markdown':
    case 'md':
    default:
      return {
        content: markdown.toMarkdown(workflow),
        filename: markdown.markdownFilename(workflow),
        mimeType: 'text/markdown',
      };
  }
}

export default exportWorkflow;
