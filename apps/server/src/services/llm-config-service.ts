import {
  YagrConfigService,
  getDefaultBaseUrlForProvider,
  getDefaultModelForProvider,
  getProviderDisplayName,
  getProviderSetupHint,
  getYagrPaths,
  isProviderConfigured,
  providerNeedsBaseUrlInput,
  providerRequiresApiKey,
  YAGR_SELECTABLE_MODEL_PROVIDERS,
} from '../lib/yagr-runtime.js';

export class LlmConfigService {
  constructor(private readonly configService = new YagrConfigService()) {}

  getSnapshot() {
    const localConfig = this.configService.getLocalConfig();
    const provider = localConfig.provider;
    const paths = getYagrPaths();

    return {
      ready: isProviderConfigured(localConfig, (candidate: string) => this.configService.getApiKey(candidate)),
      source: {
        homeDir: paths.homeDir,
        configPath: paths.yagrConfigPath,
        credentialsPath: paths.yagrCredentialsPath,
      },
      stored: {
        provider: provider ?? null,
        model: localConfig.model,
        baseUrl: localConfig.baseUrl,
        apiKeyStored: provider ? Boolean(this.configService.getApiKey(provider)) : false,
      },
      effective: {
        provider: provider ?? null,
        providerLabel: provider ? getProviderDisplayName(provider) : 'Not configured',
        model: localConfig.model ?? '',
        baseUrl: localConfig.baseUrl,
        apiKeyAvailable: provider ? Boolean(this.configService.getApiKey(provider)) : false,
        apiKeySource: provider && this.configService.getApiKey(provider) ? 'yagr' : 'environment',
      },
      providers: YAGR_SELECTABLE_MODEL_PROVIDERS.map((candidate: string) => ({
        id: candidate,
        label: getProviderDisplayName(candidate),
        defaultModel: getDefaultModelForProvider(candidate),
        defaultBaseUrl: getDefaultBaseUrlForProvider(candidate),
        requiresApiKey: providerRequiresApiKey(candidate),
        requiresBaseUrl: providerNeedsBaseUrlInput(candidate),
        setupHint: getProviderSetupHint(candidate),
      })),
    };
  }

  getConfigStore(): YagrConfigService {
    return this.configService;
  }
}
