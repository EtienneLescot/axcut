import { createLangChainChatModel, normalizeProviderId, providerRequiresApiKey, resolveProviderRuntimeConfig } from '@yagr/provider-runtime';

import type { LlmConfigService } from '../services/llm-config-service.js';

export function createAxcutChatModel(configService: LlmConfigService) {
  const config = configService.getRuntimeConfig();
  if (config.provider && !normalizeProviderId(config.provider)) {
    throw new Error(`The selected Yagr provider ${config.provider} is not supported by Axcut yet. Choose one of: openai, anthropic, google, mistral, openrouter, openai-compatible.`);
  }
  const effective = resolveProviderRuntimeConfig(config);
  if (providerRequiresApiKey(effective.provider) && !effective.apiKey) {
    throw new Error(`An API key is required for provider ${effective.provider}. Run \`npm run llm:setup\` or \`yagr llm setup\`.`);
  }

  return createLangChainChatModel({
    provider: effective.provider,
    model: effective.model,
    apiKey: effective.apiKey,
    baseUrl: effective.baseUrl,
    temperature: 0,
  });
}
