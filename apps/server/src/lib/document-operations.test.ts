import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyDocument, type AxcutDocument, type AxcutSuggestion } from '@axcut/schema';

import { applyDocumentOperation, replaceSuggestions } from './document-operations.js';
import { buildTimelineFromIntervals } from './timeline.js';

function createDocument(): AxcutDocument {
  const base = createEmptyDocument({
    projectId: 'proj_suggestions',
    title: 'Suggestion Test',
    createdAt: '2026-04-22T08:00:00.000Z',
  });
  const transcript = {
    assetId: 'asset_main',
    language: 'en',
    segments: [
      { id: 's1', kind: 'speech' as const, startSec: 0, endSec: 2, text: 'uh hello', wordIds: ['w1', 'w2'] },
    ],
    words: [
      { id: 'w1', segmentId: 's1', startSec: 0, endSec: 0.2, text: 'uh' },
      { id: 'w2', segmentId: 's1', startSec: 0.3, endSec: 1.2, text: 'hello' },
    ],
  };
  return {
    ...base,
    project: { ...base.project, primaryAssetId: 'asset_main' },
    assets: [{ id: 'asset_main', kind: 'video', label: 'main.mp4', originalPath: '/tmp/main.mp4', durationSec: 2 }],
    transcript,
    timeline: {
      ...base.timeline,
      clips: buildTimelineFromIntervals('asset_main', [{ startSec: 0, endSec: 2 }], {
        origin: 'system',
        reason: 'initial',
        transcript,
      }),
    },
  };
}

test('replaceSuggestions stores new suggestions and summary', () => {
  const document = createDocument();
  const suggestions: AxcutSuggestion[] = [{
    id: 'sug_1',
    status: 'pending',
    category: 'cut_candidate',
    suggestion: 'Cut filler word "uh"',
    reason: 'Detected filler word.',
    startWordId: 'w1',
    endWordId: 'w1',
    proposedOperation: {
      type: 'drop_word_range',
      startWordId: 'w1',
      endWordId: 'w1',
      reason: 'Remove filler word.',
    },
  }];

  const updated = replaceSuggestions(document, suggestions, 'Prepared one suggestion.');
  assert.equal(updated.agent.suggestions.length, 1);
  assert.equal(updated.agent.lastReasoningSummary, 'Prepared one suggestion.');
});

test('approving a suggestion applies its operation and marks it approved', () => {
  const document = replaceSuggestions(createDocument(), [{
    id: 'sug_1',
    status: 'pending',
    category: 'cut_candidate',
    suggestion: 'Cut filler word "uh"',
    reason: 'Detected filler word.',
    startWordId: 'w1',
    endWordId: 'w1',
    proposedOperation: {
      type: 'drop_word_range',
      startWordId: 'w1',
      endWordId: 'w1',
      reason: 'Remove filler word.',
    },
  }], 'Prepared one suggestion.');

  const updated = applyDocumentOperation(document, {
    type: 'approve_suggestion',
    suggestionId: 'sug_1',
    reason: 'Approved by user.',
  }, 'user');

  assert.equal(updated.agent.suggestions[0].status, 'approved');
  assert.equal(updated.timeline.clips.length, 1);
  assert.deepEqual(updated.timeline.clips[0].wordRefs, ['w2']);
});

test('rejecting a suggestion leaves timeline intact and marks it rejected', () => {
  const document = replaceSuggestions(createDocument(), [{
    id: 'sug_1',
    status: 'pending',
    category: 'cut_candidate',
    suggestion: 'Cut filler word "uh"',
    reason: 'Detected filler word.',
    startWordId: 'w1',
    endWordId: 'w1',
    proposedOperation: {
      type: 'drop_word_range',
      startWordId: 'w1',
      endWordId: 'w1',
      reason: 'Remove filler word.',
    },
  }], 'Prepared one suggestion.');

  const updated = applyDocumentOperation(document, {
    type: 'reject_suggestion',
    suggestionId: 'sug_1',
    reason: 'Rejected by user.',
  }, 'user');

  assert.equal(updated.agent.suggestions[0].status, 'rejected');
  assert.equal(updated.timeline.clips[0].sourceStartSec, 0);
  assert.equal(updated.timeline.clips[0].sourceEndSec, 2);
});
