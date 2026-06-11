import { getReasoningCapability, normalizeReasoningEffortForCapability } from '../llm/agent-provider-capabilities.js';
import { LlmConfigStore } from '../llm/llm-config-store.js';
import { beginCodexDeviceAuth, completeCodexDeviceAuth, ensureOpenAiAccountSession, fetchOpenAiAccountModels } from '../llm/provider-runtime/openai-account.js';
import { fetchGitHubCopilotModels } from '../llm/provider-runtime/copilot-account.js';
import {
  AXCUT_SELECTABLE_MODEL_PROVIDERS,
  getDefaultBaseUrlForProvider,
  getDefaultModelForProvider,
  getProviderDisplayName,
  getProviderSetupHint,
  isOAuthAccountProvider,
  isProviderConfigured,
  normalizeProviderId,
  providerNeedsBaseUrlInput,
  providerRequiresApiKey,
  providerSupportsReasoningEffort,
  PROVIDER_DEFINITIONS,
  type AxcutLocalConfig,
  type AxcutModelProvider,
  type AxcutReasoningEffort,
} from '../llm/provider-registry.js';

type DeviceChallenge = {
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  deviceAuthId?: string;
  deviceCode?: string;
  intervalMs: number;
  expiresAt: number;
};

const MINIMAX_DISCOVERY_CANDIDATE_MODELS = [
  'MiniMax-M2.7',
  'MiniMax-M2.7-highspeed',
  'MiniMax-M2.5',
  'MiniMax-M2.5-highspeed',
  'MiniMax-M2.1',
  'MiniMax-M2.1-highspeed',
  'MiniMax-M2',
] as const;

class ProviderAuthExpiredError extends Error {
  readonly statusCode = 401;
  readonly code = 'provider_auth_expired';
  readonly reconnectRequired = true;

  constructor(provider: AxcutModelProvider, detail?: string) {
    super(`${getProviderDisplayName(provider)} authentication expired. Reconnect this provider to load models.${detail ? ` ${detail}` : ''}`);
    this.name = 'ProviderAuthExpiredError';
  }
}

export class LlmConfigService {
  constructor(private readonly configService = new LlmConfigStore()) {}

  getSnapshot() {
    const localConfig = this.configService.getLocalConfig();
    const provider = localConfig.provider;
    const paths = this.configService.getPaths();
    const isReady = isProviderConfigured(localConfig, (candidate) => this.getStoredOrEnvironmentApiKey(candidate));
    const providers = AXCUT_SELECTABLE_MODEL_PROVIDERS.map((candidate) => this.buildProviderState(candidate, localConfig));

    return {
      ready: isReady,
      source: {
        homeDir: paths.homeDir,
        configPath: paths.configPath,
        credentialsPath: paths.credentialsPath,
        accountAuthRoot: paths.accountAuthRoot,
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
        reasoningEffort: providerSupportsReasoningEffort(provider, localConfig.model) ? localConfig.reasoningEffort : undefined,
        supportsReasoningEffort: providerSupportsReasoningEffort(provider, localConfig.model),
        apiKeyAvailable: provider ? Boolean(this.getStoredOrEnvironmentApiKey(provider)) : false,
        apiKeySource: provider && this.configService.getApiKey(provider) ? 'stored' : 'environment',
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
    if (provider === 'copilot-proxy' && !apiKey) {
      return { challenge: await beginGitHubCopilotAuth(), snapshot: this.getSnapshot() };
    }

    if (apiKey) {
      this.configService.saveApiKey(provider, apiKey);
    }

    const prepared = await this.prepareProviderRuntime(provider, {
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
      reasoningEffort: providerSupportsReasoningEffort(provider, model) ? this.optionalReasoningEffort(input.reasoningEffort) : undefined,
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
      this.configService.saveApiKey(provider, '');
    } else if (provider === 'copilot-proxy') {
      const token = await completeGitHubDeviceAuth({
        verificationUri: this.optionalString(input.verificationUri) || 'https://github.com/login/device',
        userCode: this.requireString(input.userCode, 'userCode'),
        deviceCode: this.requireString(input.deviceCode, 'deviceCode'),
        intervalMs: this.requireNumber(input.intervalMs, 'intervalMs'),
        expiresAt: this.requireNumber(input.expiresAt, 'expiresAt'),
      });
      this.configService.saveApiKey(provider, token);
    } else {
      throw new Error(`${provider} does not use device authentication.`);
    }

    const model = typeof input.model === 'string' && input.model.trim()
      ? input.model.trim()
      : getDefaultModelForProvider(provider);
    const baseUrl = getDefaultBaseUrlForProvider(provider);
    const reasoningEffort = this.optionalReasoningEffort(input.reasoningEffort);
    const prepared = await this.prepareProviderRuntime(provider, { apiKey: this.getStoredOrEnvironmentApiKey(provider), baseUrl });
    this.configService.saveLocalConfig({
      ...this.configService.getLocalConfig(),
      provider,
      model,
      baseUrl,
      ...(providerSupportsReasoningEffort(provider, model) ? { reasoningEffort } : { reasoningEffort: undefined }),
    });
    return { prepared, snapshot: this.getSnapshot() };
  }

  selectProvider(providerId: string, input: Record<string, unknown> = {}) {
    const provider = this.requireProvider(providerId);
    const model = this.optionalString(input.model) || getDefaultModelForProvider(provider);
    this.configService.saveLocalConfig({
      ...this.configService.getLocalConfig(),
      provider,
      model,
      baseUrl: this.optionalString(input.baseUrl) || getDefaultBaseUrlForProvider(provider),
      reasoningEffort: providerSupportsReasoningEffort(provider, model) ? this.optionalReasoningEffort(input.reasoningEffort) : undefined,
    });
    return this.getSnapshot();
  }

  disconnectProvider(providerId: string) {
    const provider = this.requireProvider(providerId);
    this.configService.saveApiKey(provider, '');
    const localConfig = this.configService.getLocalConfig();
    if (localConfig.provider === provider) {
      this.configService.saveLocalConfig({});
    }
    return this.getSnapshot();
  }

  async listProviderModels(providerId: string, input: { baseUrl?: unknown } = {}) {
    const provider = this.requireProvider(providerId);
    const baseUrl = this.optionalString(input.baseUrl) || this.configService.getLocalConfig().baseUrl || getDefaultBaseUrlForProvider(provider);
    const apiKey = this.getStoredOrEnvironmentApiKey(provider);
    const prepared = await this.prepareProviderRuntime(provider, { apiKey, baseUrl });
    if (!prepared.ready) {
      throw new Error(prepared.reason || `Provider ${getProviderDisplayName(provider)} is not ready.`);
    }
    const models = await this.fetchAvailableModels(provider, apiKey, baseUrl);
    return {
      provider,
      models: [...new Set(models)],
      prepared,
    };
  }

  getRuntimeConfig() {
    const localConfig = this.configService.getLocalConfig();
    const provider = localConfig.provider;
    if (!provider) {
      throw new Error('No LLM provider is configured. Configure a provider from the Axcut web UI.');
    }
    const model = localConfig.model || getDefaultModelForProvider(provider);
    const apiKey = this.getStoredOrEnvironmentApiKey(provider);
    if (providerRequiresApiKey(provider) && !apiKey) {
      throw new Error(`Missing API key for ${getProviderDisplayName(provider)}. Configure a provider from the Axcut web UI.`);
    }
    if (providerNeedsBaseUrlInput(provider) && !localConfig.baseUrl) {
      throw new Error(`Missing base URL for ${getProviderDisplayName(provider)}. Configure a provider from the Axcut web UI.`);
    }
    return {
      provider,
      model,
      apiKey,
      baseUrl: localConfig.baseUrl || getDefaultBaseUrlForProvider(provider),
      reasoningEffort: normalizeReasoningEffortForCapability(localConfig.reasoningEffort, getReasoningCapability(provider, model)),
    };
  }

  private buildProviderState(provider: AxcutModelProvider, localConfig: AxcutLocalConfig) {
    const storedApiKey = this.configService.getApiKey(provider);
    const environmentApiKey = this.getEnvironmentApiKey(provider);
    const selected = localConfig.provider === provider;
    const connected = isOAuthAccountProvider(provider)
      ? selected || Boolean(storedApiKey || environmentApiKey)
      : Boolean(storedApiKey || environmentApiKey) || (!providerRequiresApiKey(provider) && selected);
    const model = selected ? localConfig.model : undefined;

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
      model,
      baseUrl: selected ? localConfig.baseUrl : getDefaultBaseUrlForProvider(provider),
      supportsReasoningEffort: providerSupportsReasoningEffort(provider, model || getDefaultModelForProvider(provider)),
      reasoningEffort: selected && providerSupportsReasoningEffort(provider, model) ? localConfig.reasoningEffort : undefined,
      credentialSource: storedApiKey ? 'stored' : environmentApiKey ? 'environment' : null,
    };
  }

  private getStoredOrEnvironmentApiKey(provider: AxcutModelProvider): string | undefined {
    return this.configService.getApiKey(provider)?.trim() || this.getEnvironmentApiKey(provider);
  }

  private getEnvironmentApiKey(provider: AxcutModelProvider): string | undefined {
    for (const key of PROVIDER_DEFINITIONS[provider].envKeys) {
      const value = process.env[key]?.trim();
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  private requireProvider(providerId: string): AxcutModelProvider {
    const provider = normalizeProviderId(providerId);
    if (!provider) {
      throw new Error(`Unknown provider ${providerId}`);
    }
    return provider;
  }

  private async prepareProviderRuntime(provider: AxcutModelProvider, input: { apiKey?: string; baseUrl?: string }) {
    if (providerRequiresApiKey(provider) && !input.apiKey) {
      return { ready: false, reason: `Missing API key for ${getProviderDisplayName(provider)}.` };
    }
    if (providerNeedsBaseUrlInput(provider) && !input.baseUrl) {
      return { ready: false, reason: `Missing base URL for ${getProviderDisplayName(provider)}.` };
    }
    return {
      ready: true,
      provider,
      baseUrl: input.baseUrl,
      models: await this.fetchAvailableModels(provider, input.apiKey, input.baseUrl).catch(() => []),
    };
  }

  private async fetchAvailableModels(provider: AxcutModelProvider, apiKey?: string, baseUrl?: string): Promise<string[]> {
    if (provider === 'copilot-proxy' && apiKey) {
      return fetchGitHubCopilotModels(apiKey).catch((error) => {
        throw this.toProviderModelDiscoveryError(provider, error);
      });
    }
    if (provider === 'openai-oauth') {
      const session = await ensureOpenAiAccountSession() || await ensureOpenAiAccountSession(apiKey);
      if (!session?.accessToken) {
        throw new ProviderAuthExpiredError(provider, 'No active account session was found.');
      }
      return fetchOpenAiAccountModels(session.accessToken).catch((error) => {
        throw this.toProviderModelDiscoveryError(provider, error);
      });
    }
    if (provider === 'anthropic') {
      return fetchModelIds('https://api.anthropic.com/v1/models', undefined, { 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' })
        .catch((error) => {
          throw this.toProviderModelDiscoveryError(provider, error);
        });
    }
    if (provider === 'google') {
      return fetchModelIds('https://generativelanguage.googleapis.com/v1beta/openai/models', undefined, { Authorization: `Bearer ${apiKey}` })
        .then((models) => models.map((model) => model.replace(/^models\//, '')).filter((model) => /^gemini-/i.test(model)))
        .catch((error) => {
          throw this.toProviderModelDiscoveryError(provider, error);
        });
    }
    if (provider === 'mistral') {
      return fetchModelIds('https://api.mistral.ai/v1/models', apiKey).catch((error) => {
        throw this.toProviderModelDiscoveryError(provider, error);
      });
    }
    if (provider === 'minimax' || provider === 'minimax-token-plan') {
      return this.probeMiniMaxModels(provider, apiKey, baseUrl);
    }
    const modelsBaseUrl = provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : baseUrl || getDefaultBaseUrlForProvider(provider);
    if (!modelsBaseUrl) {
      return [];
    }
    return fetchModelIds(`${modelsBaseUrl.replace(/\/+$/, '')}/models`, apiKey).catch((error) => {
      throw this.toProviderModelDiscoveryError(provider, error);
    });
  }

  private toProviderModelDiscoveryError(provider: AxcutModelProvider, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (isAuthenticationFailure(message)) {
      return new ProviderAuthExpiredError(provider);
    }
    return new Error(message || `Could not load models for ${getProviderDisplayName(provider)}.`);
  }

  private async probeMiniMaxModels(provider: AxcutModelProvider, apiKey?: string, baseUrl?: string): Promise<string[]> {
    if (!apiKey) {
      return [];
    }
    const url = this.getMiniMaxCompletionDiscoveryUrl(baseUrl);
    const checks = await Promise.all(
      MINIMAX_DISCOVERY_CANDIDATE_MODELS.map(async (model) => {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
            }),
          });
          if (response.status === 401 || response.status === 403) {
            const body = await response.text().catch(() => '');
            throw new ProviderAuthExpiredError(provider, body.trim());
          }
          return response.ok ? model : undefined;
        } catch (error) {
          if (error instanceof ProviderAuthExpiredError) {
            throw error;
          }
          return undefined;
        }
      }),
    );
    return checks.filter((model): model is typeof MINIMAX_DISCOVERY_CANDIDATE_MODELS[number] => Boolean(model));
  }

  private getMiniMaxCompletionDiscoveryUrl(baseUrl?: string): string {
    const resolvedBaseUrl = baseUrl || getDefaultBaseUrlForProvider('minimax') || 'https://api.minimax.io/anthropic';
    if (resolvedBaseUrl.endsWith('/anthropic')) {
      return resolvedBaseUrl.replace(/\/anthropic\/?$/, '/v1/chat/completions');
    }
    return `${resolvedBaseUrl.replace(/\/$/, '')}/v1/chat/completions`;
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

  private optionalReasoningEffort(value: unknown): AxcutReasoningEffort | undefined {
    return typeof value === 'string' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)
      ? value as AxcutReasoningEffort
      : undefined;
  }
}

async function beginGitHubCopilotAuth(): Promise<DeviceChallenge> {
  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: 'Iv1.b507a08c87ecfe98', scope: 'read:user' }),
  });
  if (!response.ok) {
    throw new Error(`GitHub device code failed: HTTP ${response.status}`);
  }
  const payload = await response.json() as Record<string, unknown>;
  return {
    verificationUri: String(payload.verification_uri || 'https://github.com/login/device'),
    userCode: String(payload.user_code || ''),
    deviceCode: String(payload.device_code || ''),
    intervalMs: Math.max(1000, Number(payload.interval || 5) * 1000),
    expiresAt: Date.now() + Number(payload.expires_in || 900) * 1000,
  };
}

async function completeGitHubDeviceAuth(challenge: DeviceChallenge): Promise<string> {
  while (Date.now() < challenge.expiresAt) {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'Iv1.b507a08c87ecfe98',
        device_code: challenge.deviceCode || '',
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const accessToken = String(payload.access_token || '');
    if (accessToken) {
      return accessToken;
    }
    const error = String(payload.error || '');
    if (error && error !== 'authorization_pending' && error !== 'slow_down') {
      throw new Error(String(payload.error_description || error));
    }
    await new Promise((resolve) => setTimeout(resolve, challenge.intervalMs));
  }
  throw new Error('GitHub Copilot device login expired.');
}

async function fetchModelIds(url: string, apiKey?: string, headers: Record<string, string> = {}): Promise<string[]> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error([`Model discovery failed: HTTP ${response.status}`, body.trim()].filter(Boolean).join(' - '));
  }
  const payload = await response.json() as Record<string, unknown>;
  const data = Array.isArray(payload.data) ? payload.data : [];
  return data
    .map((entry) => entry && typeof entry === 'object' ? String((entry as Record<string, unknown>).id || '').trim() : '')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function isAuthenticationFailure(message: string): boolean {
  return /\b(401|403|unauthorized|forbidden|expired|invalid[_ -]?token|invalid[_ -]?grant|token refresh failed)\b/i.test(message);
}
