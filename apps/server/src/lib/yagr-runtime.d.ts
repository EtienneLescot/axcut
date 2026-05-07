export type YagrLocalConfig = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  [key: string]: unknown;
};

export declare class YagrConfigService {
  getLocalConfig(): YagrLocalConfig;
  getApiKey(provider: string): string | undefined;
  saveApiKey(provider: string, apiKey: string): void;
  saveLocalConfig(config: YagrLocalConfig): void;
}

export declare function getYagrPaths(): {
  homeDir: string;
  yagrConfigPath: string;
  yagrCredentialsPath: string;
};

export declare function createLangChainModel(config?: unknown, configStore?: unknown): Promise<BaseChatModel>;

export declare const YAGR_SELECTABLE_MODEL_PROVIDERS: readonly string[];
export declare function getDefaultBaseUrlForProvider(provider: string): string | undefined;
export declare function getDefaultModelForProvider(provider: string): string;
export declare function getProviderDisplayName(provider: string): string;
export declare function getProviderSetupHint(provider: string): string | undefined;
export declare function isProviderConfigured(localConfig: YagrLocalConfig, getApiKey: (provider: string) => string | undefined): boolean;
export declare function providerNeedsBaseUrlInput(provider: string): boolean;
export declare function providerRequiresApiKey(provider: string): boolean;
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
