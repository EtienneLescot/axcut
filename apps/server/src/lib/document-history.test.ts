import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyDocument, type AxcutOperation } from '@axcut/schema';

import { appendRevision, refreshProjectUpdatedAt } from './document-history.js';

test('appendRevision records a new revision entry', () => {
  const base = createEmptyDocument({
    projectId: 'proj_test',
    title: 'History Test',
    createdAt: '2026-04-21T20:00:00.000Z',
  });
  const operation: AxcutOperation = {
    type: 'restore_full_timeline',
    reason: 'Reset everything',
  };

  const updated = appendRevision(base, {
    author: 'user',
    summary: 'Reset timeline',
    operations: [operation],
  }, () => 'rev_test', '2026-04-21T20:01:00.000Z');

  assert.equal(updated.history.revisions.length, 1);
  assert.equal(updated.history.revisions[0].id, 'rev_test');
  assert.equal(updated.history.revisions[0].summary, 'Reset timeline');
  assert.deepEqual(updated.history.revisions[0].operations, [operation]);
});

test('refreshProjectUpdatedAt updates the project timestamp only', () => {
  const base = createEmptyDocument({
    projectId: 'proj_test',
    title: 'History Test',
    createdAt: '2026-04-21T20:00:00.000Z',
  });
  const updated = refreshProjectUpdatedAt(base, '2026-04-21T20:05:00.000Z');

  assert.equal(updated.project.updatedAt, '2026-04-21T20:05:00.000Z');
  assert.equal(updated.project.createdAt, '2026-04-21T20:00:00.000Z');
  assert.equal(updated.history.revisions.length, 0);
});
