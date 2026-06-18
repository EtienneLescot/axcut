import test from 'node:test';
import assert from 'node:assert/strict';

import { applySkipRangesToClips, createEmptyDocument, ensureDocument, normalizeSkipRanges } from './index.js';

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

test('normalizeSkipRanges merges touching and overlapping skips per source asset', () => {
  const normalized = normalizeSkipRanges([
    { id: 'skip_2', assetId: 'asset_1', startSec: 2, endSec: 3, reason: 'silence', origin: 'agent' },
    { id: 'skip_1', assetId: 'asset_1', startSec: 1, endSec: 2, reason: 'blank', origin: 'user' },
    { id: 'skip_3', assetId: 'asset_2', startSec: 2, endSec: 3, reason: 'other asset', origin: 'system' },
    { id: 'skip_4', assetId: 'asset_1', startSec: 5, endSec: 6, reason: 'separate', origin: 'system' },
  ]);

  assert.deepEqual(normalized.map((skip) => ({
    id: skip.id,
    assetId: skip.assetId,
    startSec: skip.startSec,
    endSec: skip.endSec,
    reason: skip.reason,
    origin: skip.origin,
  })), [
    { id: 'skip_1', assetId: 'asset_1', startSec: 1, endSec: 3, reason: 'blank; silence', origin: 'user' },
    { id: 'skip_4', assetId: 'asset_1', startSec: 5, endSec: 6, reason: 'separate', origin: 'system' },
    { id: 'skip_3', assetId: 'asset_2', startSec: 2, endSec: 3, reason: 'other asset', origin: 'system' },
  ]);
});
