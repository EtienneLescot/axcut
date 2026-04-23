import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { YagrConfigService } from '../../yagr-axcut-primitives/src/config/yagr-config-service.js';
import {
  YAGR_SELECTABLE_MODEL_PROVIDERS,
  getDefaultBaseUrlForProvider,
  getDefaultModelForProvider,
  getProviderDisplayName,
  getProviderSetupHint,
  isOAuthAccountProvider,
  providerNeedsBaseUrlInput,
  providerRequiresApiKey,
} from '../../yagr-axcut-primitives/src/llm/provider-registry.js';
import { fetchAvailableModels } from '../../yagr-axcut-primitives/src/llm/provider-discovery.js';
import { prepareProviderRuntime } from '../../yagr-axcut-primitives/src/llm/proxy-runtime.js';
import { beginGitHubCopilotAuth, completeGitHubCopilotAuth, ensureGitHubCopilotSession } from '../../yagr-axcut-primitives/src/llm/copilot-account.js';
import { beginCodexAuth, completeCodexAuth, ensureOpenAiAccountSession, getOpenAiAccountSession } from '../../yagr-axcut-primitives/src/llm/openai-account.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.YAGR_LAUNCH_CWD ??= repoRoot;

function print(line = '') {
  output.write(`${line}\n`);
}

function normalizeAnswer(value) {
  return value.trim();
}

async function askText(rl, label, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = normalizeAnswer(await rl.question(`${label}${suffix}: `));
  return answer || defaultValue || '';
}

async function askYesNo(rl, label, defaultValue = true) {
  const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
  const answer = normalizeAnswer((await rl.question(`${label}${suffix}: `))).toLowerCase();
  if (!answer) {
    return defaultValue;
  }
  return answer === 'y' || answer === 'yes';
}

async function askChoice(rl, label, options, defaultIndex = 0) {
  print(label);
  options.forEach((option, index) => {
    print(`  ${index + 1}. ${option}`);
  });
  while (true) {
    const answer = normalizeAnswer(await rl.question(`Select an option [${defaultIndex + 1}]: `));
    const selectedIndex = answer ? Number.parseInt(answer, 10) - 1 : defaultIndex;
    if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < options.length) {
      return selectedIndex;
    }
    print('Invalid selection.');
  }
}

async function chooseModel(rl, models, fallbackModel) {
  if (models.length === 0) {
    return askText(rl, 'Model', fallbackModel);
  }

  const uniqueModels = Array.from(new Set(models));
  const options = [
    ...uniqueModels.slice(0, 20),
    'Custom model',
  ];
  const defaultIndex = Math.max(0, options.findIndex((model) => model === fallbackModel));
  const selected = options[await askChoice(rl, 'Available models', options, defaultIndex >= 0 ? defaultIndex : 0)];
  if (selected === 'Custom model') {
    return askText(rl, 'Custom model', fallbackModel);
  }
  return selected;
}

async function hasAccountSession(provider) {
  if (provider === 'copilot-proxy') {
    return (await ensureGitHubCopilotSession()) !== undefined;
  }
  if (provider === 'openai-oauth') {
    return (await ensureOpenAiAccountSession()) !== undefined;
  }
  return false;
}

async function runProviderAuth(rl, provider) {
  if (provider === 'anthropic-proxy') {
    print('On a machine where Claude CLI is installed and logged in, run `claude setup-token`.');
    return askText(rl, 'Paste Claude setup-token', '');
  }

  if (provider === 'openai-oauth') {
    const challenge = await beginCodexAuth();
    print('Open this URL in your browser and sign in with your ChatGPT account:');
    print(challenge.authUrl);
    await askText(rl, challenge.callbackServerStarted ? 'Press Enter after sign-in' : 'Paste the callback URL', '');
    await completeCodexAuth();
    const session = getOpenAiAccountSession();
    if (!session?.accessToken) {
      throw new Error('OpenAI OAuth completed but no session was stored.');
    }
    return session.accessToken;
  }

  if (provider === 'copilot-proxy') {
    const challenge = await beginGitHubCopilotAuth();
    print(`Open: ${challenge.verificationUri}`);
    print(`Enter code: ${challenge.userCode}`);
    await askText(rl, 'Press Enter after browser authorization', '');
    await completeGitHubCopilotAuth(challenge);
    return undefined;
  }

  return undefined;
}

async function run() {
  const rl = createInterface({ input, output });
  const yagrConfig = new YagrConfigService();

  try {
    const localConfig = yagrConfig.getLocalConfig();

    print('Axcut LLM setup');
    print('This wizard uses Yagr provider management, auth flows, and model discovery.');
    print();

    if (localConfig.provider && localConfig.model) {
      print(`Current configuration: ${getProviderDisplayName(localConfig.provider)} / ${localConfig.model}`);
      if (await askYesNo(rl, 'Keep the current configuration', true)) {
        print('Keeping current configuration.');
        return;
      }
      print();
    }

    const providerOptions = YAGR_SELECTABLE_MODEL_PROVIDERS.map((provider) => {
      const hint = getProviderSetupHint(provider);
      return `${getProviderDisplayName(provider)} (${provider})${hint ? ` - ${hint}` : ''}`;
    });
    const defaultProviderIndex = Math.max(0, YAGR_SELECTABLE_MODEL_PROVIDERS.findIndex((provider) => provider === localConfig.provider));
    const provider = YAGR_SELECTABLE_MODEL_PROVIDERS[await askChoice(rl, 'Providers', providerOptions, defaultProviderIndex >= 0 ? defaultProviderIndex : 0)];

    let baseUrl = providerNeedsBaseUrlInput(provider)
      ? await askText(rl, 'Base URL', (localConfig.provider === provider ? localConfig.baseUrl : undefined) || getDefaultBaseUrlForProvider(provider) || '')
      : (localConfig.provider === provider ? localConfig.baseUrl : undefined) || getDefaultBaseUrlForProvider(provider) || undefined;
    if (!baseUrl) {
      baseUrl = undefined;
    }

    let apiKey = undefined;
    if (providerRequiresApiKey(provider)) {
      const existingKey = yagrConfig.getApiKey(provider);
      apiKey = await askText(rl, 'API key', existingKey || '');
      if (!apiKey) {
        apiKey = existingKey;
      }
    } else if (isOAuthAccountProvider(provider)) {
      const canReuse = await hasAccountSession(provider);
      const shouldAuthenticate = !canReuse || await askYesNo(rl, 'Start or refresh provider authentication', !canReuse);
      if (shouldAuthenticate) {
        apiKey = await runProviderAuth(rl, provider);
      }
    }

    const prepared = await prepareProviderRuntime(provider, { apiKey, baseUrl });
    if (!prepared.ready && prepared.error) {
      throw new Error(prepared.error);
    }

    let discoveredModels = [];
    try {
      discoveredModels = prepared.models?.length
        ? prepared.models
        : await fetchAvailableModels(provider, apiKey, baseUrl);
    } catch (error) {
      print(`Model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const defaultModel = (localConfig.provider === provider ? localConfig.model : undefined) || getDefaultModelForProvider(provider);
    const model = await chooseModel(rl, discoveredModels, defaultModel);

    if (apiKey) {
      yagrConfig.saveApiKey(provider, apiKey);
    }
    yagrConfig.saveLocalConfig({
      ...localConfig,
      provider,
      model,
      baseUrl,
      reasoningEffort: localConfig.reasoningEffort,
    });

    print();
    print(`Saved: ${getProviderDisplayName(provider)} / ${model}`);
    if (baseUrl) {
      print(`Base URL: ${baseUrl}`);
    }
  } finally {
    rl.close();
  }
}

run().catch((error) => {
  print(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
