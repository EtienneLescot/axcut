import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyDocument, type AxcutDocument } from '@axcut/schema';

import { applyTimelineOperation, buildTimelineFromIntervals, normalizeIntervals } from './timeline.js';

function createDocument(): AxcutDocument {
  const base = createEmptyDocument({
    projectId: 'proj_timeline',
    title: 'Timeline Test',
    createdAt: '2026-04-21T20:00:00.000Z',
  });
  const words = [
    { id: 'w1', segmentId: 's1', startSec: 0, endSec: 1, text: 'hello' },
    { id: 'w2', segmentId: 's1', startSec: 1, endSec: 2, text: 'world' },
    { id: 'w3', segmentId: 's2', startSec: 3, endSec: 4, text: 'again' },
    { id: 'w4', segmentId: 's2', startSec: 4, endSec: 5, text: 'later' },
  ];
  const transcript = {
    assetId: 'asset_main',
    language: 'en',
    segments: [
      { id: 's1', kind: 'speech' as const, startSec: 0, endSec: 2, text: 'hello world', wordIds: ['w1', 'w2'] },
      { id: 's2', kind: 'speech' as const, startSec: 3, endSec: 5, text: 'again later', wordIds: ['w3', 'w4'] },
    ],
    words,
  };
  const clips = buildTimelineFromIntervals('asset_main', [{ startSec: 0, endSec: 5 }], {
    origin: 'system',
    reason: 'initial',
    transcript,
  });

  return {
    ...base,
    project: {
      ...base.project,
      primaryAssetId: 'asset_main',
    },
    assets: [
      {
        id: 'asset_main',
        kind: 'video',
        label: 'main.mp4',
        originalPath: '/tmp/main.mp4',
        durationSec: 5,
      },
    ],
    transcript,
    timeline: {
      ...base.timeline,
      clips,
    },
  };
}

test('normalizeIntervals merges overlaps and clips to duration', () => {
  const intervals = normalizeIntervals(10, [
    { startSec: -1, endSec: 2 },
    { startSec: 1.5, endSec: 3 },
    { startSec: 9, endSec: 12 },
  ]);

  assert.deepEqual(intervals, [
    { startSec: 0, endSec: 3 },
    { startSec: 9, endSec: 10 },
  ]);
});

test('applyTimelineOperation drops a selected word range and increments preview revision', () => {
  const document = createDocument();
  const updated = applyTimelineOperation(document, {
    type: 'drop_word_range',
    startWordId: 'w2',
    endWordId: 'w3',
    reason: 'cut middle range',
  });

  assert.equal(updated.preview.revision, document.preview.revision + 1);
  assert.equal(updated.timeline.clips.length, 2);
  assert.deepEqual(
    updated.timeline.clips.map((clip) => [clip.sourceStartSec, clip.sourceEndSec]),
    [[0, 1], [4, 5]],
  );
  assert.ok(updated.timeline.clips.every((clip) => clip.origin === 'user'));
});
