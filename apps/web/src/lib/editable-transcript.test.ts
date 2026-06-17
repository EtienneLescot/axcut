import test from 'node:test';
import assert from 'node:assert/strict';

import type { AxcutDocument } from '@axcut/schema';

import { deriveEditableTranscriptUpdate } from './editable-transcript.js';

function createDocument(): AxcutDocument {
  return {
    schemaVersion: 2,
    project: {
      id: 'project_1',
      title: 'Edit transcript',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      primaryAssetId: 'asset_main',
    },
    assets: [{ id: 'asset_main', kind: 'video', label: 'main.mp4', originalPath: '/tmp/main.mp4', durationSec: 10 }],
    transcript: {
      assetId: 'asset_main',
      language: 'en',
      segments: [],
      words: [
        { id: 'w1', segmentId: 's1', startSec: 0.2, endSec: 0.5, text: 'okay' },
        { id: 'w2', segmentId: 's1', startSec: 0.55, endSec: 0.8, text: 'so' },
        { id: 'w3', segmentId: 's1', startSec: 1.1, endSec: 1.5, text: 'continue' },
      ],
    },
    transcripts: [{
      assetId: 'asset_main',
      language: 'en',
      segments: [],
      words: [
        { id: 'w1', segmentId: 's1', startSec: 0.2, endSec: 0.5, text: 'okay' },
        { id: 'w2', segmentId: 's1', startSec: 0.55, endSec: 0.8, text: 'so' },
        { id: 'w3', segmentId: 's1', startSec: 1.1, endSec: 1.5, text: 'continue' },
      ],
    }],
    timeline: {
      clips: [{
        id: 'clip_1',
        assetId: 'asset_main',
        sourceStartSec: 0,
        sourceEndSec: 2,
        timelineStartSec: 0,
        timelineEndSec: 2,
        wordRefs: ['w1', 'w2', 'w3'],
        origin: 'system',
        reason: '',
      }],
      skipRanges: [],
      gaps: [],
      muteRanges: [],
      speedRanges: [],
      captionRanges: [],
    },
    agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
    preview: { strategy: 'seek', revision: 0 },
    export: { preset: 'final-balanced', lastJobId: null },
    history: { revisions: [] },
  };
}

test('deriveEditableTranscriptUpdate removes a deleted word from current timeline intervals', () => {
  const update = deriveEditableTranscriptUpdate(createDocument(), [
    '# Clip 1: source 0:00.0-0:02.0 -> timeline 0:00.0-0:02.0',
    'okay continue',
  ].join('\n'));

  assert.ok(update);
  assert.deepEqual(update.deletedWordIds, ['w2']);
  assert.deepEqual(update.intervals, [
    { startSec: 0, endSec: 0.55 },
    { startSec: 0.8, endSec: 2 },
  ]);
});

test('deriveEditableTranscriptUpdate groups contiguous deleted words into one cut', () => {
  const update = deriveEditableTranscriptUpdate(createDocument(), 'continue');

  assert.ok(update);
  assert.deepEqual(update.deletedWordIds, ['w1', 'w2']);
  assert.deepEqual(update.intervals, [
    { startSec: 0, endSec: 0.2 },
    { startSec: 0.8, endSec: 2 },
  ]);
});

test('deriveEditableTranscriptUpdate ignores unchanged transcript text', () => {
  const update = deriveEditableTranscriptUpdate(createDocument(), 'okay so continue');
  assert.equal(update, null);
});
