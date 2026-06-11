import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentSessionService, PersistentFileCheckpointSaver } from './agent-session-service.js';

test('AgentSessionService creates, scopes, renames, rotates, and deletes sessions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axcut-sessions-'));
  const service = new AgentSessionService(root);
  const checkpointer = new PersistentFileCheckpointSaver(path.join(root, 'langgraph'));
  service.setCheckpointer(checkpointer);
  const scope = { kind: 'axcut-project', key: 'proj_1' };

  const first = service.ensure('session_1', { title: 'First', scope });
  assert.equal(first.title, 'First');
  assert.equal(service.getActiveForScope(scope)?.id, 'session_1');

  const renamed = service.touch('session_1', { title: 'Renamed' });
  assert.equal(renamed?.title, 'Renamed');

  const second = service.rotateForScope(scope, { title: 'Second' });
  assert.equal(second.title, 'Second');
  assert.equal(service.get('session_1')?.closedAt !== undefined, true);
  assert.deepEqual(service.listForScope(scope).map((session) => session.id).sort(), ['session_1', second.id].sort());

  await service.delete(second.id);
  assert.equal(service.get(second.id), undefined);
});

test('PersistentFileCheckpointSaver persists checkpoints by thread id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axcut-checkpoints-'));
  const first = new PersistentFileCheckpointSaver(root);
  const config = { configurable: { thread_id: 'session_1' } };
  await first.put(config, {
    v: 4,
    id: 'checkpoint_1',
    ts: new Date().toISOString(),
    channel_values: { messages: [] },
    channel_versions: {},
    versions_seen: {},
  }, { source: 'input', step: 0, parents: {} });

  const second = new PersistentFileCheckpointSaver(root);
  const tuple = await second.getTuple(config);
  assert.equal(tuple?.checkpoint.id, 'checkpoint_1');
});
