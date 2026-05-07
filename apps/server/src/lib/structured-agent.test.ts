import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyDocument, type AxcutDocument } from '@axcut/schema';

import { buildFillerSuggestions, buildPauseSuggestions, searchTranscript } from './structured-agent.js';
import { buildTimelineFromIntervals } from './timeline.js';

function createDocument(): AxcutDocument {
  const base = createEmptyDocument({
    projectId: 'proj_runtime',
    title: 'Runtime Test',
    createdAt: '2026-04-22T08:00:00.000Z',
  });
  const transcript = {
    assetId: 'asset_main',
    language: 'en',
    segments: [
      { id: 's1', kind: 'speech' as const, startSec: 0, endSec: 2, text: 'uh hello there', wordIds: ['w1', 'w2', 'w3'] },
      { id: 'z1', kind: 'silence' as const, startSec: 2.1, endSec: 3.0, text: '', wordIds: [] },
      { id: 's2', kind: 'speech' as const, startSec: 3.0, endSec: 5.0, text: 'find the config section', wordIds: ['w4', 'w5', 'w6', 'w7'] },
    ],
    words: [
      { id: 'w1', segmentId: 's1', startSec: 0.0, endSec: 0.2, text: 'uh' },
      { id: 'w2', segmentId: 's1', startSec: 0.3, endSec: 1.0, text: 'hello' },
      { id: 'w3', segmentId: 's1', startSec: 1.1, endSec: 1.7, text: 'there' },
      { id: 'w4', segmentId: 's2', startSec: 3.0, endSec: 3.4, text: 'find' },
      { id: 'w5', segmentId: 's2', startSec: 3.5, endSec: 3.7, text: 'the' },
      { id: 'w6', segmentId: 's2', startSec: 3.8, endSec: 4.3, text: 'config' },
      { id: 'w7', segmentId: 's2', startSec: 4.35, endSec: 4.9, text: 'section' },
    ],
  };
  return {
    ...base,
    project: { ...base.project, primaryAssetId: 'asset_main' },
    assets: [{ id: 'asset_main', kind: 'video', label: 'main.mp4', originalPath: '/tmp/main.mp4', durationSec: 5 }],
    transcript,
    timeline: {
      ...base.timeline,
      clips: buildTimelineFromIntervals('asset_main', [{ startSec: 0, endSec: 5 }], {
        origin: 'system',
        reason: 'initial',
        transcript,
      }),
    },
  };
}

test('searchTranscript returns matching spoken segments', () => {
  const hits = searchTranscript(createDocument(), 'config section');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].segmentId, 's2');
});

test('buildFillerSuggestions detects kept filler words', () => {
  const suggestions = buildFillerSuggestions(createDocument());
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].proposedOperation?.type, 'drop_word_range');
});

test('buildPauseSuggestions detects long silence ranges', () => {
  const suggestions = buildPauseSuggestions(createDocument());
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].proposedOperation?.type, 'drop_range');
});
