import test from 'node:test';
import assert from 'node:assert/strict';

import { applySkipRangesToClips, createEmptyDocument, ensureDocument } from './index.js';

test('createEmptyDocument produces a valid .axcut document', () => {
  const document = createEmptyDocument({
    projectId: 'proj_test',
    title: 'Schema Test',
    createdAt: '2026-04-21T20:00:00.000Z',
  });

  assert.equal(document.schemaVersion, 2);
  assert.equal(document.project.id, 'proj_test');
  assert.equal(document.project.title, 'Schema Test');
  assert.equal(document.preview.strategy, 'seek');
  assert.equal(document.history.revisions.length, 0);
  assert.deepEqual(document.timeline.skipRanges, []);
  assert.deepEqual(ensureDocument(document), document);
});

test('applySkipRangesToClips materializes non-destructive skips for playback', () => {
  const clips = [{
    id: 'clip_1',
    assetId: 'asset_1',
    sourceStartSec: 0,
    sourceEndSec: 10,
    timelineStartSec: 0,
    timelineEndSec: 10,
    wordRefs: [],
    origin: 'user' as const,
    reason: '',
  }];

  const materialized = applySkipRangesToClips(clips, [{
    id: 'skip_1',
    assetId: 'asset_1',
    startSec: 3,
    endSec: 5,
    reason: '',
    origin: 'user',
  }]);

  assert.deepEqual(materialized.map((clip) => ({
    sourceStartSec: clip.sourceStartSec,
    sourceEndSec: clip.sourceEndSec,
    timelineStartSec: clip.timelineStartSec,
    timelineEndSec: clip.timelineEndSec,
  })), [
    { sourceStartSec: 0, sourceEndSec: 3, timelineStartSec: 0, timelineEndSec: 3 },
    { sourceStartSec: 5, sourceEndSec: 10, timelineStartSec: 3, timelineEndSec: 8 },
  ]);
});
