import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyDocument, type AxcutDocument } from '@axcut/schema';
import { AIMessage, HumanMessage } from 'langchain';

import { buildTimelineFromIntervals } from '../lib/timeline.js';
import { buildAgentInputMessages, buildAxcutInvocationPrompt } from './axcut-deep-agent.js';

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

test('buildAxcutInvocationPrompt includes source word timestamps for precise edits', () => {
  const base = createEmptyDocument({ projectId: 'proj_words', title: 'Words' });
  const transcript: NonNullable<AxcutDocument['transcript']> = {
    assetId: 'asset_1',
    language: 'en',
    segments: [{ id: 's1', kind: 'speech', startSec: 0, endSec: 1, text: 'for me', wordIds: ['w1', 'w2'] }],
    words: [
      { id: 'w1', segmentId: 's1', startSec: 0.1, endSec: 0.3, text: 'for' },
      { id: 'w2', segmentId: 's1', startSec: 0.31, endSec: 0.55, text: 'me' },
    ],
  };
  const document: AxcutDocument = {
    ...base,
    project: { ...base.project, primaryAssetId: 'asset_1' },
    assets: [{ id: 'asset_1', kind: 'video', label: 'clip.mp4', originalPath: '/tmp/clip.mp4', durationSec: 1 }],
    transcript,
    timeline: {
      ...base.timeline,
      clips: buildTimelineFromIntervals('asset_1', [{ startSec: 0, endSec: 1 }], { origin: 'system', reason: 'test', transcript }),
    },
  };

  const prompt = buildAxcutInvocationPrompt(document, 'remove for me');
  assert.match(prompt, /"transcripts":\[/);
  assert.match(prompt, /"assetId":"asset_1"/);
  assert.match(prompt, /"id":"w1"/);
  assert.match(prompt, /"startSec":0.1/);
  assert.match(prompt, /add_skip_range/);
  assert.match(prompt, /drop_word_range/);
  assert.doesNotMatch(prompt, /speechKeepIntervalsForNonSpeakingRemoval/);
});
