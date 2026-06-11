import { getReasoningCapability, type AgentReasoningEffort } from './agent-provider-capabilities.js';

export type AxcutModelProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'mistral'
  | 'openrouter'
  | 'openai-oauth'
  | 'copilot-proxy'
  | 'minimax'
  | 'minimax-token-plan'
  | 'openai-compatible';

export type AxcutReasoningEffort = AgentReasoningEffort;

export type AxcutLocalConfig = {
  provider?: AxcutModelProvider;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: AxcutReasoningEffort;
};

export type ProviderDefinition = {
  id: AxcutModelProvider;
  label: string;
  defaultModel: string;
  defaultBaseUrl?: string;
  requiresApiKey: boolean;
  requiresBaseUrl: boolean;
  oauth: boolean;
  setupHint: string;
  envKeys: string[];
};

export const AXCUT_SELECTABLE_MODEL_PROVIDERS: readonly AxcutModelProvider[] = [
  'anthropic',
  'openai',
  'google',
  'mistral',
  'openrouter',
  'openai-oauth',
  'copilot-proxy',
  'minimax',
  'minimax-token-plan',
  'openai-compatible',
];

export const PROVIDER_DEFINITIONS: Record<AxcutModelProvider, ProviderDefinition> = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude API',
    defaultModel: 'claude-haiku-4-5',
    requiresApiKey: true,
    requiresBaseUrl: false,
    oauth: false,
    setupHint: 'Use ANTHROPIC_API_KEY or paste a Claude API key.',
    envKeys: ['ANTHROPIC_LLM_API_KEY', 'ANTHROPIC_API_KEY'],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI API',
    defaultModel: 'gpt-4o',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    requiresBaseUrl: false,
    oauth: false,
    setupHint: 'Use OPENAI_API_KEY or paste an OpenAI API key.',
    envKeys: ['OPENAI_LLM_API_KEY', 'OPENAI_API_KEY'],
  },
  google: {
    id: 'google',
    label: 'Gemini API',
    defaultModel: 'gemini-3-flash-preview',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresApiKey: true,
    requiresBaseUrl: false,
    oauth: false,
    setupHint: 'Use GOOGLE_GENERATIVE_AI_API_KEY, GEMINI_API_KEY, or paste a Gemini API key.',
    envKeys: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_LLM_API_KEY', 'GOOGLE_LLM_API_KEY'],
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral API',
    defaultModel: 'mistral-large-latest',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    requiresApiKey: true,
    requiresBaseUrl: false,
    oauth: false,
    setupHint: 'Use MISTRAL_API_KEY or paste a Mistral API key.',
    envKeys: ['MISTRAL_API_KEY', 'MISTRAL_LLM_API_KEY'],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter API',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    requiresBaseUrl: false,
    oauth: false,
    setupHint: 'Use OPENROUTER_API_KEY or paste an OpenRouter API key.',
    envKeys: ['OPENROUTER_API_KEY', 'OPENROUTER_LLM_API_KEY'],
  },
  'openai-oauth': {
    id: 'openai-oauth',
    label: 'OpenAI ChatGPT OAuth',
    defaultModel: 'gpt-5.4',
    defaultBaseUrl: 'https://chatgpt.com/backend-api',
    requiresApiKey: false,
    requiresBaseUrl: false,
    oauth: true,
    setupHint: 'Connect a ChatGPT account with the device login flow.',
    envKeys: [],
  },
  'copilot-proxy': {
    id: 'copilot-proxy',
    label: 'GitHub Copilot OAuth',
    defaultModel: 'gpt-4.1',
    defaultBaseUrl: 'https://api.individual.githubcopilot.com',
    requiresApiKey: false,
    requiresBaseUrl: false,
    oauth: true,
    setupHint: 'Use a GitHub Copilot token or connect with the device login flow.',
    envKeys: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax API',
    defaultModel: 'MiniMax-M2.7',
    defaultBaseUrl: 'https://api.minimax.io/anthropic',
    requiresApiKey: true,
    requiresBaseUrl: false,
    oauth: false,
    setupHint: 'Use MINIMAX_API_KEY or paste a MiniMax API key.',
    envKeys: ['MINIMAX_API_KEY'],
  },
  'minimax-token-plan': {
    id: 'minimax-token-plan',
    label: 'MiniMax Token Plan',
    defaultModel: 'MiniMax-M2.7',
    defaultBaseUrl: 'https://api.minimax.io/anthropic',
    requiresApiKey: true,
    requiresBaseUrl: false,
    oauth: false,
    setupHint: 'Use MINIMAX_TOKEN_PLAN_API_KEY or paste a MiniMax token-plan API key.',
    envKeys: ['MINIMAX_TOKEN_PLAN_API_KEY'],
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI Compatible',
    defaultModel: '',
    requiresApiKey: false,
    requiresBaseUrl: true,
    oauth: false,
    setupHint: 'Use a custom OpenAI-compatible base URL.',
    envKeys: ['OPENAI_COMPATIBLE_API_KEY'],
  },
};

export function normalizeProviderId(provider?: string): AxcutModelProvider | undefined {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'claude') {
    return 'anthropic';
  }
  if (normalized === 'anthropic-proxy') {
    return 'anthropic';
  }
  if (normalized === 'gemini') {
    return 'google';
  }
  return normalized in PROVIDER_DEFINITIONS ? normalized as AxcutModelProvider : undefined;
}

export function getProviderDisplayName(provider: AxcutModelProvider): string {
  return PROVIDER_DEFINITIONS[provider].label;
}

export function getDefaultModelForProvider(provider: AxcutModelProvider): string {
  return PROVIDER_DEFINITIONS[provider].defaultModel;
}

export function getDefaultBaseUrlForProvider(provider: AxcutModelProvider): string | undefined {
  return PROVIDER_DEFINITIONS[provider].defaultBaseUrl;
}

export function getProviderSetupHint(provider: AxcutModelProvider): string {
  return PROVIDER_DEFINITIONS[provider].setupHint;
}

export function providerRequiresApiKey(provider: AxcutModelProvider): boolean {
  return PROVIDER_DEFINITIONS[provider].requiresApiKey;
}

export function providerNeedsBaseUrlInput(provider: AxcutModelProvider): boolean {
  return PROVIDER_DEFINITIONS[provider].requiresBaseUrl;
}

export function isOAuthAccountProvider(provider: AxcutModelProvider): boolean {
  return PROVIDER_DEFINITIONS[provider].oauth;
}

export function providerSupportsReasoningEffort(provider: AxcutModelProvider | undefined, model?: string): boolean {
  return provider ? getReasoningCapability(provider, model).supported : false;
}

export function isProviderConfigured(localConfig: AxcutLocalConfig, getApiKey: (provider: AxcutModelProvider) => string | undefined): boolean {
  if (!localConfig.provider) {
    return false;
  }
  const definition = PROVIDER_DEFINITIONS[localConfig.provider];
  if (definition.requiresApiKey && !getApiKey(localConfig.provider)) {
    return false;
  }
  if (definition.requiresBaseUrl && !localConfig.baseUrl) {
    return false;
  }
  return Boolean(localConfig.model || definition.defaultModel || localConfig.provider === 'openai-compatible');
}
