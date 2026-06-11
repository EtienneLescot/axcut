import { ChatAnthropic } from '@langchain/anthropic';
import { ChatMistralAI } from '@langchain/mistralai';
import { ChatOpenAI } from '@langchain/openai';

import { buildLangChainReasoningOptions, shouldDisableModelStreamingForToolCalling } from './agent-provider-capabilities.js';
import { createLocalProviderLangChainModel } from './provider-runtime/create-langchain-model.js';
import type { LlmConfigService } from '../services/llm-config-service.js';

export const OPENAI_COMPATIBLE_NO_AUTH_API_KEY = 'axcut-openai-compatible-no-auth';

export function resolveOpenAIChatApiKey(provider: string, apiKey?: string) {
  if (apiKey) {
    return apiKey;
  }
  return provider === 'openai-compatible' ? OPENAI_COMPATIBLE_NO_AUTH_API_KEY : undefined;
}

export async function createAxcutChatModel(configService: LlmConfigService) {
  const config = configService.getRuntimeConfig();
  const reasoningOptions = buildLangChainReasoningOptions(config.provider, config.model, config.reasoningEffort);

  if (config.provider === 'openai-oauth' || config.provider === 'copilot-proxy' || config.provider === 'minimax' || config.provider === 'minimax-token-plan') {
    return createLocalProviderLangChainModel({
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      reasoningEffort: config.reasoningEffort,
    });
  }

  if (config.provider === 'anthropic') {
    return new ChatAnthropic({
      apiKey: config.apiKey,
      model: config.model,
      ...(reasoningOptions.thinking ? { thinking: reasoningOptions.thinking as never } : {}),
      ...(reasoningOptions.outputConfig ? { outputConfig: reasoningOptions.outputConfig as never } : {}),
    });
  }

  if (config.provider === 'mistral') {
    return new ChatMistralAI({ apiKey: config.apiKey, model: config.model });
  }

  const baseURL = config.provider === 'openrouter'
    ? config.baseUrl || 'https://openrouter.ai/api/v1'
    : config.provider === 'google'
      ? config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai'
      : config.baseUrl;
  const apiKey = resolveOpenAIChatApiKey(config.provider, config.apiKey);
  return new ChatOpenAI({
    ...(apiKey ? { apiKey } : {}),
    model: config.model,
    ...(reasoningOptions.reasoning ? { reasoning: reasoningOptions.reasoning } : {}),
    ...(reasoningOptions.useResponsesApi ? { useResponsesApi: true } : {}),
    ...(reasoningOptions.modelKwargs ? { modelKwargs: reasoningOptions.modelKwargs } : {}),
    ...(shouldDisableModelStreamingForToolCalling(config.provider, config.model) ? { disableStreaming: true } : {}),
    ...(baseURL ? { configuration: { baseURL } } : {}),
  });
}
