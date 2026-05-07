import test from 'node:test';
import assert from 'node:assert/strict';

import { AIMessage, HumanMessage } from 'langchain';

import { buildAgentInputMessages } from './axcut-deep-agent.js';

test('buildAgentInputMessages rehydrates session history without duplicating current user prompt', () => {
  const messages = buildAgentInputMessages('follow up', [
    { id: 'msg_user_1', role: 'user', content: 'first request' },
    { id: 'msg_assistant_1', role: 'assistant', content: 'first response' },
    { id: 'msg_user_2', role: 'user', content: 'follow up' },
  ], 'context\nfollow up');

  assert.equal(messages.length, 3);
  assert.ok(HumanMessage.isInstance(messages[0]));
  assert.ok(AIMessage.isInstance(messages[1]));
  assert.ok(HumanMessage.isInstance(messages[2]));
  assert.equal(messages[2].content, 'context\nfollow up');
});

test('buildAgentInputMessages appends current prompt when history is stale', () => {
  const messages = buildAgentInputMessages('new prompt', [
    { id: 'msg_user_1', role: 'user', content: 'previous request' },
  ]);

  assert.equal(messages.length, 2);
  assert.ok(HumanMessage.isInstance(messages[1]));
  assert.equal(messages[1].content, 'new prompt');
});
