import test from 'node:test';
import assert from 'node:assert/strict';

import type { AxcutClip, AxcutWord } from '@axcut/schema';

import { locateSourcePosition, locateVirtualPosition, resolvePlaybackPosition, selectWordRange, totalVirtualDuration } from './virtual-preview.js';

const clips: AxcutClip[] = [
  {
    id: 'clip_1',
    assetId: 'asset_main',
    sourceStartSec: 10,
    sourceEndSec: 14,
    timelineStartSec: 0,
    timelineEndSec: 4,
    wordRefs: ['w1', 'w2'],
    origin: 'system',
    reason: 'intro',
  },
  {
    id: 'clip_2',
    assetId: 'asset_main',
    sourceStartSec: 20,
    sourceEndSec: 23,
    timelineStartSec: 4,
    timelineEndSec: 7,
    wordRefs: ['w3'],
    origin: 'system',
    reason: 'main',
  },
];

const words: AxcutWord[] = [
  { id: 'w1', segmentId: 's1', startSec: 10, endSec: 11, text: 'hello' },
  { id: 'w2', segmentId: 's1', startSec: 11, endSec: 12, text: 'world' },
  { id: 'w3', segmentId: 's2', startSec: 20, endSec: 21, text: 'again' },
];

test('totalVirtualDuration uses the clip timeline', () => {
  assert.equal(totalVirtualDuration(clips), 7);
});

test('locateVirtualPosition maps virtual time to source time', () => {
  const position = locateVirtualPosition(clips, 5.5);
  assert.ok(position);
  assert.equal(position.clip.id, 'clip_2');
  assert.equal(position.sourceTimeSec, 21.5);
});

test('locateSourcePosition maps source time back to virtual time', () => {
  const position = locateSourcePosition(clips, 12.25);
  assert.ok(position);
  assert.equal(position.clip.id, 'clip_1');
  assert.equal(position.virtualTimeSec, 2.25);
});

test('resolvePlaybackPosition jumps across source cuts', () => {
  const position = resolvePlaybackPosition(clips, 14.02);
  assert.equal(position.kind, 'next');
  assert.equal(position.position.clip.id, 'clip_2');
  assert.equal(position.position.virtualTimeSec, 4);
  assert.equal(position.position.sourceTimeSec, 20);
});

test('resolvePlaybackPosition ends after the final kept clip', () => {
  const position = resolvePlaybackPosition(clips, 23.2);
  assert.equal(position.kind, 'ended');
  assert.equal(position.position.virtualTimeSec, 7);
  assert.equal(position.position.sourceTimeSec, 23);
});

test('selectWordRange returns the ordered range regardless of click order', () => {
  const selected = selectWordRange(words, 'w3', 'w1');
  assert.ok(selected);
  assert.equal(selected.startWordId, 'w1');
  assert.equal(selected.endWordId, 'w3');
  assert.equal(selected.text, 'hello world again');
});
