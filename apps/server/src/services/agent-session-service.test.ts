import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createEmptyDocument } from '@axcut/schema';

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

test('AgentSessionService restores checkpoint metadata and payload state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axcut-session-payload-'));
  const service = new AgentSessionService(root);
  const scope = { kind: 'axcut-project', key: 'proj_1' };
  service.ensure('session_1', { title: 'Payload session', scope });

  const payload = {
    version: 1 as const,
    projectId: 'proj_1',
    document: createEmptyDocument({ projectId: 'proj_1', title: 'Project' }),
    messages: [],
  };

  const checkpoint = await service.saveCheckpoint('session_1', {
    label: 'Manual checkpoint',
    reason: 'manual',
    summary: 'Saved state',
    payload,
  });
  const restored = await service.restoreCheckpoint('session_1', checkpoint.id);

  assert.equal(restored.checkpoint.restoredAt !== undefined, true);
  assert.equal(restored.payload?.projectId, 'proj_1');
  assert.equal(restored.langGraphRestored, false);
  assert.deepEqual(restored.warnings, ['This checkpoint does not include a runtime checkpoint.']);

  await service.deleteCheckpoint('session_1', checkpoint.id);
  assert.deepEqual(service.listCheckpointsSync('session_1'), []);
});

test('AgentSessionService preserves restored runtime checkpoint until explicitly cleared', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axcut-session-runtime-'));
  const service = new AgentSessionService(root);
  service.ensure('session_1', { title: 'Runtime session', scope: { kind: 'axcut-project', key: 'proj_1' } });

  const checkpoint = await service.saveCheckpoint('session_1', {
    label: 'Runtime checkpoint',
    reason: 'manual',
    runtimeCheckpointId: 'runtime_checkpoint_1',
  });
  const restored = await service.restoreCheckpoint('session_1', checkpoint.id);
  assert.equal(restored.langGraphRestored, true);

  assert.equal(service.buildSessionConfig('session_1').configurable?.checkpoint_id, 'runtime_checkpoint_1');
  assert.equal(service.buildSessionConfig('session_1').configurable?.checkpoint_id, 'runtime_checkpoint_1');

  service.clearRestoredRuntimeCheckpoint('session_1');
  assert.equal(service.buildSessionConfig('session_1').configurable?.checkpoint_id, undefined);
});
