import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LlmConfigStore } from './llm-config-store.js';

test('LlmConfigStore reads and writes native config and credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axcut-llm-store-'));
  const configPath = path.join(root, 'llm-config.json');
  const credentialsPath = path.join(root, 'llm-credentials.json');
  fs.writeFileSync(configPath, '{}\n');
  const store = new LlmConfigStore(configPath, credentialsPath);

  store.saveLocalConfig({ provider: 'openai', model: 'gpt-4o', reasoningEffort: 'medium' });
  store.saveApiKey('openai', 'sk-test');

  assert.deepEqual(store.getLocalConfig(), { provider: 'openai', model: 'gpt-4o', reasoningEffort: 'medium' });
  assert.equal(store.getApiKey('openai'), 'sk-test');
});

test('LlmConfigStore migrates legacy provider config when native files are absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axcut-llm-migration-'));
  const legacyRoot = path.join(root, 'legacy-provider-home');
  const nativeRoot = path.join(root, 'native');
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'yagr-config.json'), JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini' }));
  fs.writeFileSync(path.join(legacyRoot, 'credentials.json'), JSON.stringify({ providers: { openai: 'sk-legacy' } }));
  const previousHome = process.env.YAGR_HOME;
  process.env.YAGR_HOME = legacyRoot;
  try {
    const store = new LlmConfigStore(path.join(nativeRoot, 'llm-config.json'), path.join(nativeRoot, 'llm-credentials.json'));
    assert.deepEqual(store.getLocalConfig(), { provider: 'openai', model: 'gpt-4o-mini' });
    assert.equal(store.getApiKey('openai'), 'sk-legacy');
  } finally {
    if (previousHome === undefined) {
      delete process.env.YAGR_HOME;
    } else {
      process.env.YAGR_HOME = previousHome;
    }
  }
});
