import test from 'node:test';
import assert from 'node:assert/strict';

import type { AxcutDocument } from '@axcut/schema';

import { applyOptimisticTimelineOperation } from './optimistic-timeline.js';

function createDocument(): AxcutDocument {
  return {
    schemaVersion: 2,
    project: {
      id: 'project_1',
      title: 'Optimistic timeline',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      primaryAssetId: 'asset_a',
    },
    assets: [
      { id: 'asset_a', kind: 'video', label: 'a.mp4', originalPath: '/tmp/a.mp4', durationSec: 10 },
      { id: 'asset_b', kind: 'video', label: 'b.mp4', originalPath: '/tmp/b.mp4', durationSec: 4 },
    ],
    transcript: null,
    transcripts: [
      {
        assetId: 'asset_a',
        language: 'en',
        segments: [],
        words: [
          { id: 'a1', assetId: 'asset_a', segmentId: 's1', startSec: 0.2, endSec: 0.5, text: 'hello' },
          { id: 'a2', assetId: 'asset_a', segmentId: 's1', startSec: 5.2, endSec: 5.6, text: 'world' },
        ],
      },
      {
        assetId: 'asset_b',
        language: 'en',
        segments: [],
        words: [
          { id: 'b1', assetId: 'asset_b', segmentId: 's2', startSec: 0.4, endSec: 1.2, text: 'inserted' },
        ],
      },
    ],
    timeline: {
      clips: [
        {
          id: 'clip_1',
          assetId: 'asset_a',
          sourceStartSec: 0,
          sourceEndSec: 2,
          timelineStartSec: 0,
          timelineEndSec: 2,
          wordRefs: ['a1'],
          origin: 'system',
          reason: '',
        },
        {
          id: 'clip_2',
          assetId: 'asset_a',
          sourceStartSec: 5,
          sourceEndSec: 8,
          timelineStartSec: 2,
          timelineEndSec: 5,
          wordRefs: ['a2'],
          origin: 'system',
          reason: '',
        },
      ],
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

test('applyOptimisticTimelineOperation moves clips immediately and retimes the timeline', () => {
  const next = applyOptimisticTimelineOperation(createDocument(), {
    type: 'move_clip',
    clipId: 'clip_2',
    insertIndex: 0,
    reason: 'Move second clip first.',
  });

  assert.equal(next.preview.revision, 1);
  assert.deepEqual(next.timeline.clips.map((clip) => clip.id), ['clip_2', 'clip_1']);
  assert.deepEqual(next.timeline.clips.map((clip) => clip.sourceStartSec), [5, 0]);
  assert.deepEqual(next.timeline.clips.map((clip) => [clip.timelineStartSec, clip.timelineEndSec]), [[0, 3], [3, 5]]);
});

test('applyOptimisticTimelineOperation adds transcript skips without removing source clips', () => {
  const next = applyOptimisticTimelineOperation(createDocument(), {
    type: 'add_skip_range',
    assetId: 'asset_a',
    startSec: 0.3,
    endSec: 0.6,
    reason: 'Skip hesitation.',
  });

  assert.equal(next.timeline.clips.length, 2);
  assert.deepEqual(next.timeline.skipRanges.map((skip) => [skip.assetId, skip.startSec, skip.endSec]), [['asset_a', 0.3, 0.6]]);
});

test('applyOptimisticTimelineOperation can split a clip and insert another source', () => {
  const next = applyOptimisticTimelineOperation(createDocument(), {
    type: 'insert_asset_clip',
    assetId: 'asset_b',
    insertAtSec: 1,
    mode: 'split',
    sourceStartSec: 0,
    reason: 'Insert asset B.',
  });

  assert.deepEqual(next.timeline.clips.map((clip) => clip.assetId), ['asset_a', 'asset_b', 'asset_a', 'asset_a']);
  assert.deepEqual(next.timeline.clips.map((clip) => [clip.timelineStartSec, clip.timelineEndSec]), [[0, 1], [1, 5], [5, 6], [6, 9]]);
});
