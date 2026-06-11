import test from 'node:test';
import assert from 'node:assert/strict';

import { OPENAI_COMPATIBLE_NO_AUTH_API_KEY, resolveOpenAIChatApiKey } from './create-chat-model.js';

test('resolveOpenAIChatApiKey supplies a placeholder for no-auth OpenAI-compatible providers', () => {
  assert.equal(resolveOpenAIChatApiKey('openai-compatible'), OPENAI_COMPATIBLE_NO_AUTH_API_KEY);
});

test('resolveOpenAIChatApiKey preserves configured keys and leaves other providers unset', () => {
  assert.equal(resolveOpenAIChatApiKey('openai-compatible', 'local-key'), 'local-key');
  assert.equal(resolveOpenAIChatApiKey('openai'), undefined);
});
