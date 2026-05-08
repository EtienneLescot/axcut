import {
  YagrConfigService,
  beginCodexDeviceAuth,
  beginGitHubCopilotAuth,
  completeCodexDeviceAuth,
  completeGitHubCopilotAuth,
  fetchAvailableModels,
  getDefaultBaseUrlForProvider,
  getDefaultModelForProvider,
  getProviderDisplayName,
  getProviderSetupHint,
  getYagrPaths,
  isProviderConfigured,
  isOAuthAccountProvider,
  normalizeProviderId,
  prepareProviderRuntime,
  providerNeedsBaseUrlInput,
  providerRequiresApiKey,
  YAGR_SELECTABLE_MODEL_PROVIDERS,
  type YagrLocalConfig,
  type YagrModelProvider,
} from '@yagr/provider-runtime';

const providerEnvKeys: Partial<Record<YagrModelProvider, string[]>> = {
  openai: ['OPENAI_LLM_API_KEY', 'OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_LLM_API_KEY', 'ANTHROPIC_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_LLM_API_KEY', 'GOOGLE_LLM_API_KEY'],
  mistral: ['MISTRAL_API_KEY', 'MISTRAL_LLM_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY', 'OPENROUTER_LLM_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-token-plan': ['MINIMAX_TOKEN_PLAN_API_KEY'],
  'openai-compatible': ['OPENAI_COMPATIBLE_API_KEY'],
  'copilot-proxy': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
};

function providerSupportsReasoningEffort(provider: YagrModelProvider | undefined): boolean {
  return provider === 'openai-oauth';
}

export class LlmConfigService {
  constructor(private readonly configService = new YagrConfigService()) {}

  getSnapshot() {
    const localConfig = this.configService.getLocalConfig();
    const provider = localConfig.provider;
    const paths = getYagrPaths();
    const isReady = isProviderConfigured(localConfig, (candidate) => this.getStoredOrEnvironmentApiKey(candidate));
    const providers = YAGR_SELECTABLE_MODEL_PROVIDERS.map((candidate) => this.buildProviderState(candidate, localConfig));

    return {
      ready: isReady,
      source: {
        homeDir: paths.homeDir,
        configPath: paths.yagrConfigPath,
        credentialsPath: paths.yagrCredentialsPath,
      },
      stored: {
        provider: provider ?? null,
        model: localConfig.model,
        baseUrl: localConfig.baseUrl,
        reasoningEffort: localConfig.reasoningEffort,
        apiKeyStored: provider ? Boolean(this.configService.getApiKey(provider)) : false,
      },
      effective: {
        provider: provider ?? null,
        providerLabel: provider ? getProviderDisplayName(provider) : 'Not configured',
        model: localConfig.model ?? '',
        baseUrl: localConfig.baseUrl,
        reasoningEffort: providerSupportsReasoningEffort(provider) ? localConfig.reasoningEffort : undefined,
        supportsReasoningEffort: providerSupportsReasoningEffort(provider),
        apiKeyAvailable: provider ? Boolean(this.getStoredOrEnvironmentApiKey(provider)) : false,
        apiKeySource: provider && this.configService.getApiKey(provider) ? 'yagr' : 'environment',
      },
      providers,
      connectedProviders: providers.filter((candidate) => candidate.connected),
      availableProviders: providers.filter((candidate) => !candidate.connected),
    };
  }

  async connectProvider(providerId: string, input: Record<string, unknown> = {}) {
    const provider = this.requireProvider(providerId);
    const baseUrl = this.optionalString(input.baseUrl) || getDefaultBaseUrlForProvider(provider);
    const model = this.optionalString(input.model) || getDefaultModelForProvider(provider);
    const apiKey = this.optionalString(input.apiKey);

    if (provider === 'openai-oauth') {
      return { challenge: await beginCodexDeviceAuth(), snapshot: this.getSnapshot() };
    }
    if (provider === 'copilot-proxy') {
      return { challenge: await beginGitHubCopilotAuth(), snapshot: this.getSnapshot() };
    }

    if (apiKey) {
      this.configService.saveApiKey(provider, apiKey);
    }

    const prepared = await prepareProviderRuntime(provider, {
      apiKey: apiKey || this.getStoredOrEnvironmentApiKey(provider),
      baseUrl,
    });
    if (!prepared.ready && prepared.reason && providerRequiresApiKey(provider) && !this.getStoredOrEnvironmentApiKey(provider)) {
      throw new Error(prepared.reason);
    }

    this.configService.saveLocalConfig({
      ...this.configService.getLocalConfig(),
      provider,
      model,
      baseUrl,
      reasoningEffort: providerSupportsReasoningEffort(provider) ? this.optionalReasoningEffort(input.reasoningEffort) : undefined,
    });

    return { prepared, snapshot: this.getSnapshot() };
  }

  async completeDeviceProvider(providerId: string, input: Record<string, unknown> = {}) {
    const provider = this.requireProvider(providerId);
    if (provider === 'openai-oauth') {
      await completeCodexDeviceAuth({
        deviceAuthId: this.requireString(input.deviceAuthId, 'deviceAuthId'),
        userCode: this.requireString(input.userCode, 'userCode'),
        intervalMs: this.requireNumber(input.intervalMs, 'intervalMs'),
        expiresAt: this.requireNumber(input.expiresAt, 'expiresAt'),
      });
    } else if (provider === 'copilot-proxy') {
      await completeGitHubCopilotAuth({
        deviceCode: this.requireString(input.deviceCode, 'deviceCode'),
        intervalMs: this.requireNumber(input.intervalMs, 'intervalMs'),
        expiresAt: this.requireNumber(input.expiresAt, 'expiresAt'),
      });
    } else {
      throw new Error(`${provider} does not use device authentication.`);
    }

    const model = typeof input.model === 'string' && input.model.trim()
      ? input.model.trim()
      : getDefaultModelForProvider(provider);
    const baseUrl = getDefaultBaseUrlForProvider(provider);
    const reasoningEffort = this.optionalReasoningEffort(input.reasoningEffort);
    const prepared = await prepareProviderRuntime(provider, { baseUrl });
    this.configService.saveLocalConfig({
      ...this.configService.getLocalConfig(),
      provider,
      model,
      baseUrl,
      ...(providerSupportsReasoningEffort(provider) ? { reasoningEffort } : { reasoningEffort: undefined }),
    });
    return { prepared, snapshot: this.getSnapshot() };
  }

  selectProvider(providerId: string, input: Record<string, unknown> = {}) {
    const provider = this.requireProvider(providerId);
    this.configService.saveLocalConfig({
      ...this.configService.getLocalConfig(),
      provider,
      model: this.optionalString(input.model) || getDefaultModelForProvider(provider),
      baseUrl: this.optionalString(input.baseUrl) || getDefaultBaseUrlForProvider(provider),
      reasoningEffort: providerSupportsReasoningEffort(provider) ? this.optionalReasoningEffort(input.reasoningEffort) : undefined,
    });
    return this.getSnapshot();
  }

  disconnectProvider(providerId: string) {
    const provider = this.requireProvider(providerId);
    this.configService.saveApiKey(provider, '');
    const localConfig = this.configService.getLocalConfig();
    if (localConfig.provider === provider) {
      const { provider: _provider, model: _model, baseUrl: _baseUrl, reasoningEffort: _reasoningEffort, ...rest } = localConfig;
      void _provider;
      void _model;
      void _baseUrl;
      void _reasoningEffort;
      this.configService.saveLocalConfig(rest);
    }
    return this.getSnapshot();
  }

  async listProviderModels(providerId: string, input: { baseUrl?: unknown } = {}) {
    const provider = this.requireProvider(providerId);
    const baseUrl = this.optionalString(input.baseUrl) || this.configService.getLocalConfig().baseUrl || getDefaultBaseUrlForProvider(provider);
    const apiKey = this.getStoredOrEnvironmentApiKey(provider);
    const prepared = await prepareProviderRuntime(provider, { apiKey, baseUrl });
    const models = prepared.runtime?.models?.length
      ? prepared.runtime.models
      : await fetchAvailableModels(provider, apiKey, baseUrl).catch(() => []);
    return {
      provider,
      models: models.length ? [...new Set(models)] : [getDefaultModelForProvider(provider)].filter(Boolean),
      prepared,
    };
  }

  getConfigStore(): YagrConfigService {
    return this.configService;
  }

  private buildProviderState(provider: YagrModelProvider, localConfig: YagrLocalConfig) {
    const storedApiKey = this.configService.getApiKey(provider);
    const environmentApiKey = this.getEnvironmentApiKey(provider);
    const selected = localConfig.provider === provider;
    const connected = isOAuthAccountProvider(provider)
      ? selected || Boolean(storedApiKey || environmentApiKey)
      : Boolean(storedApiKey || environmentApiKey) || (!providerRequiresApiKey(provider) && selected);

    return {
      id: provider,
      label: getProviderDisplayName(provider),
      defaultModel: getDefaultModelForProvider(provider),
      defaultBaseUrl: getDefaultBaseUrlForProvider(provider),
      requiresApiKey: providerRequiresApiKey(provider),
      requiresBaseUrl: providerNeedsBaseUrlInput(provider),
      oauth: isOAuthAccountProvider(provider),
      setupHint: getProviderSetupHint(provider),
      connected,
      selected,
      model: selected ? localConfig.model : undefined,
      baseUrl: selected ? localConfig.baseUrl : getDefaultBaseUrlForProvider(provider),
      supportsReasoningEffort: providerSupportsReasoningEffort(provider),
      reasoningEffort: selected && providerSupportsReasoningEffort(provider) ? localConfig.reasoningEffort : undefined,
      credentialSource: storedApiKey ? 'yagr' : environmentApiKey ? 'environment' : null,
    };
  }

  private getStoredOrEnvironmentApiKey(provider: YagrModelProvider): string | undefined {
    return this.configService.getApiKey(provider)?.trim() || this.getEnvironmentApiKey(provider);
  }

  private getEnvironmentApiKey(provider: YagrModelProvider): string | undefined {
    for (const key of providerEnvKeys[provider] ?? []) {
      const value = process.env[key]?.trim();
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  private requireProvider(providerId: string): YagrModelProvider {
    const provider = normalizeProviderId(providerId);
    if (!provider) {
      throw new Error(`Unknown provider ${providerId}`);
    }
    return provider;
  }

  private requireString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Missing ${label}.`);
    }
    return value.trim();
  }

  private requireNumber(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Missing ${label}.`);
    }
    return value;
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private optionalReasoningEffort(value: unknown): YagrLocalConfig['reasoningEffort'] | undefined {
    return typeof value === 'string' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)
      ? value as YagrLocalConfig['reasoningEffort']
      : undefined;
  }
}
