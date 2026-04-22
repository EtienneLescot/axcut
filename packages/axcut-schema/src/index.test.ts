import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyDocument, ensureDocument } from './index.js';

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
  assert.deepEqual(ensureDocument(document), document);
});
