import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getDefaultBaseUrlForProvider,
  getDefaultModelForProvider,
  getRuntimeProviderLabel,
  listRuntimeProviders,
  normalizeProviderId,
  providerRequiresApiKey,
  resolveProviderRuntimeConfig,
  type ProviderRuntimeConfig,
} from '@yagr/provider-runtime';

type YagrLocalConfig = {
  provider?: string;
  model?: string;
  baseUrl?: string;
};

type YagrCredentials = {
  providers?: Record<string, string>;
};

function resolveYagrHomeDir(): string {
  const configuredHome = process.env.YAGR_HOME?.trim();
  if (configuredHome) {
    return path.isAbsolute(configuredHome)
      ? configuredHome
      : path.resolve(process.cwd(), configuredHome);
  }

  if (process.platform === 'win32') {
    const appDataDir = process.env.APPDATA?.trim();
    if (appDataDir) {
      return path.join(appDataDir, 'yagr');
    }
    return path.join(os.homedir(), 'AppData', 'Roaming', 'yagr');
  }

  return path.join(os.homedir(), '.yagr');
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export class LlmConfigService {
  private readonly yagrHomeDir: string;
  private readonly yagrConfigPath: string;
  private readonly yagrCredentialsPath: string;

  constructor() {
    this.yagrHomeDir = resolveYagrHomeDir();
    this.yagrConfigPath = path.join(this.yagrHomeDir, 'yagr-config.json');
    this.yagrCredentialsPath = path.join(this.yagrHomeDir, 'credentials.json');
  }

  getSnapshot() {
    const stored = this.readStoredConfig();
    const supportedProvider = normalizeProviderId(stored.provider);
    const effective = supportedProvider
      ? resolveProviderRuntimeConfig(stored)
      : null;
    const requiresKey = effective ? providerRequiresApiKey(effective.provider) : false;
    const unsupportedProvider = stored.provider && !supportedProvider ? stored.provider : null;

    return {
      ready: Boolean(effective && (!requiresKey || effective.apiKey)),
      source: {
        homeDir: this.yagrHomeDir,
        configPath: this.yagrConfigPath,
        credentialsPath: this.yagrCredentialsPath,
      },
      stored: {
        provider: stored.provider,
        model: stored.model,
        baseUrl: stored.baseUrl,
        apiKeyStored: Boolean(stored.apiKey),
      },
      effective: effective
        ? {
            provider: effective.provider,
            providerLabel: getRuntimeProviderLabel(effective.provider),
            model: effective.model,
            baseUrl: effective.baseUrl,
            apiKeyAvailable: Boolean(effective.apiKey),
            apiKeySource: stored.apiKey ? 'yagr' : 'environment',
          }
        : {
            provider: null,
            providerLabel: unsupportedProvider ? `Unsupported (${unsupportedProvider})` : 'Not configured',
            model: stored.model ?? '',
            baseUrl: stored.baseUrl,
            apiKeyAvailable: Boolean(stored.apiKey),
            apiKeySource: stored.apiKey ? 'yagr' : 'environment',
          },
      unsupportedProvider,
      providers: listRuntimeProviders().map((provider) => ({
        id: provider,
        label: getRuntimeProviderLabel(provider),
        defaultModel: getDefaultModelForProvider(provider),
        defaultBaseUrl: getDefaultBaseUrlForProvider(provider),
        requiresApiKey: providerRequiresApiKey(provider),
      })),
    };
  }

  getRuntimeConfig(): ProviderRuntimeConfig {
    return this.readStoredConfig();
  }

  private readStoredConfig(): ProviderRuntimeConfig {
    const config = readJsonFile<YagrLocalConfig>(this.yagrConfigPath) ?? {};
    const credentials = readJsonFile<YagrCredentials>(this.yagrCredentialsPath) ?? {};
    const provider = typeof config.provider === 'string' ? config.provider.trim() : undefined;
    const apiKey = provider ? credentials.providers?.[provider]?.trim() : undefined;

    return {
      provider,
      model: typeof config.model === 'string' ? config.model.trim() : undefined,
      baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl.trim() : undefined,
      apiKey: apiKey || undefined,
    };
  }
}
