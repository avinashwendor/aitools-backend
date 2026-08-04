/**
 * Plan gates + share sanitize — unit tests without Mongo/LLM.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  planAllows,
  planLimit,
  creditCost,
  CREDIT_COSTS,
} from '../src/billing/plans.js';
import { sanitizeWorkflowForShare, makeShareSlug } from '../src/models/SharedWorkflow.js';

describe('plan feature gates', () => {
  test('Hobby cannot recall memory or web-search', () => {
    assert.equal(planAllows('free', 'memoryRecall'), false);
    assert.equal(planAllows('free', 'webSearch'), false);
    assert.equal(planLimit('free', 'sessionRetentionDays'), 7);
  });

  test('Pro can recall memory and keeps sessions for a year', () => {
    assert.equal(planAllows('pro', 'memoryRecall'), true);
    assert.equal(planAllows('pro', 'webSearch'), true);
    assert.equal(planLimit('pro', 'sessionRetentionDays'), 365);
  });

  test('taskboard.create and catalog.search are priced', () => {
    assert.equal(creditCost('taskboard.create'), CREDIT_COSTS['taskboard.create']);
    assert.equal(creditCost('catalog.search'), 1);
    assert.ok(creditCost('taskboard.create') > 0);
  });
});

describe('share sanitize', () => {
  test('strips internal fields and keeps playbook essentials', () => {
    const snap = sanitizeWorkflowForShare({
      id: 'wf_x',
      title: 'Launch a podcast',
      outcome: 'Episode 1 live',
      summary: 'Plan',
      meta: { cached: true, secret: true },
      stages: [
        {
          id: 's1',
          title: 'Script',
          toolSlug: 'chatgpt',
          tool: { name: 'ChatGPT', websiteUrl: 'https://chatgpt.com', internalScore: 9 },
          steps: [{ title: 'Draft', detail: 'Outline' }],
          prompt: 'Write a script',
          why: 'Fast',
          debugTrace: 'should go',
        },
      ],
    });

    assert.equal(snap.title, 'Launch a podcast');
    assert.equal(snap.stages.length, 1);
    assert.equal(snap.stages[0].tool.name, 'ChatGPT');
    assert.equal(snap.stages[0].tool.internalScore, undefined);
    assert.equal(snap.meta, undefined);
    assert.equal(snap.stages[0].debugTrace, undefined);
  });

  test('makeShareSlug is URL-safe and non-empty', () => {
    const slug = makeShareSlug('Launch a Podcast!!!');
    assert.match(slug, /^[a-z0-9-]+$/);
    assert.ok(slug.length > 4);
  });
});
