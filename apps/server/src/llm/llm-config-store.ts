import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { accountAuthRoot, llmConfigPath, llmCredentialsPath, repoRoot } from '../lib/paths.js';
import {
  AXCUT_SELECTABLE_MODEL_PROVIDERS,
  normalizeProviderId,
  type AxcutLocalConfig,
  type AxcutModelProvider,
} from './provider-registry.js';

type CredentialsFile = {
  providers?: Partial<Record<AxcutModelProvider, string>>;
};

const reasoningEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export class LlmConfigStore {
  constructor(
    private readonly configPath = llmConfigPath,
    private readonly credentialsPath = llmCredentialsPath,
  ) {
    this.migrateFromLegacyProviderIfNeeded();
  }

  getLocalConfig(): AxcutLocalConfig {
    return normalizeLocalConfig(readJson(this.configPath));
  }

  saveLocalConfig(config: AxcutLocalConfig): void {
    writeJson(this.configPath, normalizeLocalConfig(config));
  }

  getApiKey(provider: AxcutModelProvider): string | undefined {
    return this.readCredentials().providers?.[provider]?.trim() || undefined;
  }

  saveApiKey(provider: AxcutModelProvider, apiKey: string): void {
    const credentials = this.readCredentials();
    credentials.providers ??= {};
    if (apiKey.trim()) {
      credentials.providers[provider] = apiKey.trim();
    } else {
      delete credentials.providers[provider];
    }
    writeJson(this.credentialsPath, credentials, 0o600);
  }

  getPaths() {
    return {
      homeDir: path.dirname(this.configPath),
      configPath: this.configPath,
      credentialsPath: this.credentialsPath,
      accountAuthRoot,
    };
  }

  private readCredentials(): CredentialsFile {
    const parsed = readJson(this.credentialsPath);
    return parsed && typeof parsed === 'object' ? parsed as CredentialsFile : {};
  }

  private migrateFromLegacyProviderIfNeeded(): void {
    if (fs.existsSync(this.configPath) || fs.existsSync(this.credentialsPath)) {
      return;
    }

    const legacyPaths = getLegacyProviderPaths();
    const legacyConfig = normalizeLocalConfig(readJson(legacyPaths.configPath));
    const legacyCredentials = readLegacyCredentials(legacyPaths.credentialsPath);

    if (legacyConfig.provider || Object.keys(legacyCredentials.providers ?? {}).length > 0) {
      if (legacyConfig.provider) {
        writeJson(this.configPath, legacyConfig);
      }
      if (Object.keys(legacyCredentials.providers ?? {}).length > 0) {
        writeJson(this.credentialsPath, legacyCredentials, 0o600);
      }
    }

    copyLegacyAuthFile(path.join(legacyPaths.accountAuthRoot, 'copilot-oauth.json'), path.join(accountAuthRoot, 'copilot-oauth.json'));
    copyLegacyAuthFile(path.join(legacyPaths.accountAuthRoot, 'copilot-runtime-token.json'), path.join(accountAuthRoot, 'copilot-runtime-token.json'));
    copyLegacyAuthFile(path.join(os.homedir(), '.codex', 'auth.json'), path.join(accountAuthRoot, 'openai-oauth.json'));
  }
}

function normalizeLocalConfig(value: unknown): AxcutLocalConfig {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const record = value as Record<string, unknown>;
  const provider = typeof record.provider === 'string' ? normalizeProviderId(record.provider) : undefined;
  const model = typeof record.model === 'string' && record.model.trim() ? record.model.trim() : undefined;
  const baseUrl = typeof record.baseUrl === 'string' && record.baseUrl.trim() ? record.baseUrl.trim() : undefined;
  const reasoningEffort = typeof record.reasoningEffort === 'string' && reasoningEfforts.has(record.reasoningEffort)
    ? record.reasoningEffort as AxcutLocalConfig['reasoningEffort']
    : undefined;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function readLegacyCredentials(credentialsPath: string): CredentialsFile {
  const parsed = readJson(credentialsPath);
  const providers = parsed && typeof parsed === 'object'
    ? (parsed as { providers?: unknown }).providers
    : undefined;
  if (!providers || typeof providers !== 'object') {
    return {};
  }

  const credentials: CredentialsFile = { providers: {} };
  for (const provider of AXCUT_SELECTABLE_MODEL_PROVIDERS) {
    const value = (providers as Record<string, unknown>)[provider];
    if (typeof value === 'string' && value.trim()) {
      credentials.providers![provider] = value.trim();
    }
  }
  return credentials;
}

function getLegacyProviderPaths() {
  const homeDir = resolveLegacyProviderHomeDir();
  return {
    homeDir,
    accountAuthRoot: path.join(homeDir, 'oauth'),
    configPath: path.join(homeDir, 'yagr-config.json'),
    credentialsPath: path.join(homeDir, 'credentials.json'),
  };
}

function resolveLegacyProviderHomeDir(): string {
  const configuredHome = process.env.YAGR_HOME?.trim();
  if (configuredHome) {
    return path.isAbsolute(configuredHome) ? configuredHome : path.resolve(repoRoot, configuredHome);
  }
  if (process.platform === 'win32') {
    const appDataDir = process.env.APPDATA?.trim();
    return appDataDir ? path.join(appDataDir, 'yagr') : path.join(os.homedir(), 'AppData', 'Roaming', 'yagr');
  }
  return path.join(os.homedir(), '.yagr');
}

function copyLegacyAuthFile(sourcePath: string, targetPath: string): void {
  try {
    if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) {
      return;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {
      // Best effort on platforms/filesystems without chmod support.
    }
  } catch {
    // Migration is best effort.
  }
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function writeJson(filePath: string, value: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  if (mode !== undefined) {
    try {
      fs.chmodSync(filePath, mode);
    } catch {
      // Best effort on platforms/filesystems without chmod support.
    }
  }
}
