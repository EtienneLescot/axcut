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
  assert.equal(updated.timeline.clips.length, 1);
  assert.deepEqual(
    updated.timeline.clips.map((clip) => [clip.sourceStartSec, clip.sourceEndSec]),
    [[0, 5]],
  );
  assert.deepEqual(updated.timeline.skipRanges.map((skip) => [skip.assetId, skip.startSec, skip.endSec]), [
    ['asset_main', 1, 4],
  ]);
  assert.equal(updated.timeline.skipRanges[0].origin, 'user');
});

test('applyTimelineOperation rejects ambiguous word ids across mounted assets', () => {
  const document = createDocument();
  const extraTranscript: NonNullable<AxcutDocument['transcript']> = {
    assetId: 'asset_extra',
    language: 'en',
    segments: [
      { id: 's1', kind: 'speech', startSec: 0, endSec: 1, text: 'other words', wordIds: ['w1', 'w2'] },
    ],
    words: [
      { id: 'w1', segmentId: 's1', startSec: 0, endSec: 0.4, text: 'other' },
      { id: 'w2', segmentId: 's1', startSec: 0.5, endSec: 1, text: 'words' },
    ],
  };
  const withExtraMounted: AxcutDocument = {
    ...document,
    assets: [
      ...document.assets,
      { id: 'asset_extra', kind: 'video', label: 'extra.mp4', originalPath: '/tmp/extra.mp4', durationSec: 1 },
    ],
    transcripts: [document.transcript!, extraTranscript],
    timeline: {
      ...document.timeline,
      clips: [
        ...document.timeline.clips,
        ...buildTimelineFromIntervals('asset_extra', [{ startSec: 0, endSec: 1 }], {
          origin: 'system',
          reason: 'extra',
          transcript: extraTranscript,
        }),
      ],
    },
  };

  assert.throws(() => applyTimelineOperation(withExtraMounted, {
    type: 'drop_word_range',
    startWordId: 'w1',
    endWordId: 'w2',
    reason: 'ambiguous',
  }), /ambiguous across multiple assets/);
});

test('applyTimelineOperation updates a skip range without changing clip bounds', () => {
  const document = applyTimelineOperation(createDocument(), {
    type: 'add_skip_range',
    assetId: 'asset_main',
    startSec: 1,
    endSec: 2,
    reason: 'skip',
  });

  const updated = applyTimelineOperation(document, {
    type: 'update_skip_range',
    skipId: 'skip_1',
    startSec: 1.5,
    endSec: 3,
    reason: 'resize skip',
  });

  assert.deepEqual(updated.timeline.clips.map((clip) => [clip.sourceStartSec, clip.sourceEndSec]), [[0, 5]]);
  assert.deepEqual(updated.timeline.skipRanges.map((skip) => [skip.id, skip.startSec, skip.endSec]), [['skip_1', 1.5, 3]]);
});

test('applyTimelineOperation merges touching skip ranges in the timeline DSL', () => {
  const first = applyTimelineOperation(createDocument(), {
    type: 'add_skip_range',
    assetId: 'asset_main',
    startSec: 1,
    endSec: 2,
    reason: 'blank',
  });

  const second = applyTimelineOperation(first, {
    type: 'add_skip_range',
    assetId: 'asset_main',
    startSec: 2,
    endSec: 3,
    reason: 'silence',
  });

  assert.deepEqual(second.timeline.skipRanges.map((skip) => [skip.id, skip.assetId, skip.startSec, skip.endSec, skip.reason]), [
    ['skip_1', 'asset_main', 1, 3, 'blank; silence'],
  ]);
});

test('applyTimelineOperation merges a resized skip into its neighbor', () => {
  const first = applyTimelineOperation(createDocument(), {
    type: 'add_skip_range',
    assetId: 'asset_main',
    startSec: 1,
    endSec: 2,
    reason: 'blank',
  });
  const second = applyTimelineOperation(first, {
    type: 'add_skip_range',
    assetId: 'asset_main',
    startSec: 3,
    endSec: 4,
    reason: 'hesitation',
  });

  const updated = applyTimelineOperation(second, {
    type: 'update_skip_range',
    skipId: 'skip_1',
    startSec: 1,
    endSec: 3,
    reason: 'extended blank',
  });

  assert.deepEqual(updated.timeline.skipRanges.map((skip) => [skip.id, skip.startSec, skip.endSec, skip.reason]), [
    ['skip_1', 1, 4, 'extended blank; hesitation'],
  ]);
});

test('applyTimelineOperation updates clip bounds and retimes the timeline', () => {
  const document = createDocument();

  const updated = applyTimelineOperation(document, {
    type: 'update_clip_range',
    clipId: 'clip_1',
    sourceStartSec: 1,
    sourceEndSec: 4,
    reason: 'trim clip',
  });

  assert.deepEqual(updated.timeline.clips.map((clip) => [clip.sourceStartSec, clip.sourceEndSec, clip.timelineStartSec, clip.timelineEndSec]), [
    [1, 4, 0, 3],
  ]);
});

test('applyTimelineOperation duplicates a clip after the selected clip', () => {
  const document = createDocument();

  const updated = applyTimelineOperation(document, {
    type: 'duplicate_clip',
    clipId: 'clip_1',
    reason: 'duplicate',
  });

  assert.deepEqual(updated.timeline.clips.map((clip) => [clip.sourceStartSec, clip.sourceEndSec, clip.timelineStartSec, clip.timelineEndSec]), [
    [0, 5, 0, 5],
    [0, 5, 5, 10],
  ]);
});

test('applyTimelineOperation moves a clip to a new order and retimes the timeline', () => {
  const baseDocument = createDocument();
  const baseClip = baseDocument.timeline.clips[0];
  const document = {
    ...baseDocument,
    timeline: {
      ...baseDocument.timeline,
      clips: [
        { ...baseClip, id: 'clip_1', sourceStartSec: 0, sourceEndSec: 1, timelineStartSec: 0, timelineEndSec: 1 },
        { ...baseClip, id: 'clip_2', sourceStartSec: 1, sourceEndSec: 3, timelineStartSec: 1, timelineEndSec: 3 },
        { ...baseClip, id: 'clip_3', sourceStartSec: 3, sourceEndSec: 5, timelineStartSec: 3, timelineEndSec: 5 },
      ],
    },
  };

  const updated = applyTimelineOperation(document, {
    type: 'move_clip',
    clipId: 'clip_1',
    insertIndex: 2,
    reason: 'move clip',
  });

  assert.deepEqual(updated.timeline.clips.map((clip) => [clip.id, clip.timelineStartSec, clip.timelineEndSec]), [
    ['clip_2', 0, 2],
    ['clip_3', 2, 4],
    ['clip_1', 4, 5],
  ]);
});
