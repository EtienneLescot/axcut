import test from 'node:test';
import assert from 'node:assert/strict';

import type { AxcutWord } from '@axcut/schema';

import { findCueWordId } from './CurrentTranscriptView.js';

test('cue focus stays on the previous word during a gap', () => {
  const words: AxcutWord[] = [
    { id: 'need', segmentId: 's1', startSec: 7.48, endSec: 8.36, text: 'need' },
    { id: 'vs', segmentId: 's1', startSec: 8.58, endSec: 8.88, text: 'VS' },
  ];

  assert.equal(findCueWordId(words, 8.44), 'need');
});

test('cue focus moves to the word when it is pronounced', () => {
  const words: AxcutWord[] = [
    { id: 'need', segmentId: 's1', startSec: 7.48, endSec: 8.36, text: 'need' },
    { id: 'vs', segmentId: 's1', startSec: 8.58, endSec: 8.88, text: 'VS' },
  ];

  assert.equal(findCueWordId(words, 8.58), 'vs');
});

test('cue focus moves to materialized silence tokens', () => {
  const words: AxcutWord[] = [
    { id: 'workspace', segmentId: 's1', startSec: 56.56, endSec: 57.66, text: 'workspace' },
    { id: 'silence_s1_0_57.660_61.920', segmentId: 'silence_s1', startSec: 57.66, endSec: 61.92, text: '(4.3s)' },
    { id: 'okay', segmentId: 's2', startSec: 61.92, endSec: 63.04, text: 'okay' },
  ];

  assert.equal(findCueWordId(words, 59), 'silence_s1_0_57.660_61.920');
});
