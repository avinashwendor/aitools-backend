/**
 * OpenRouter 402 affordability parsing — the failure that used to ship dummy
 * playbooks while logging `tried: none`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAffordableTokens, isTokenAffordabilityError } from '../src/ai/llm.js';

describe('OpenRouter token affordability', () => {
  test('parses "can only afford N" from 402 messages', () => {
    const err = {
      message:
        '402 This request requires more credits, or fewer max_tokens. ' +
        'You requested up to 6600 tokens, but can only afford 3554.',
    };
    assert.equal(parseAffordableTokens(err), 3554);
    assert.equal(isTokenAffordabilityError(err), true);
  });

  test('does not treat a true empty-account message as affordability', () => {
    const err = { message: '429 You have no credits remaining. Add credits to continue.' };
    assert.equal(parseAffordableTokens(err), null);
    assert.equal(isTokenAffordabilityError(err), false);
  });

  test('returns null when the message has no affordability signal', () => {
    assert.equal(parseAffordableTokens({ message: 'model not found' }), null);
    assert.equal(isTokenAffordabilityError({ message: 'model not found' }), false);
  });
});
