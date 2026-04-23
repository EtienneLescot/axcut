import { createLangChainModel } from '../lib/yagr-runtime.js';
import type { LlmConfigService } from '../services/llm-config-service.js';

export async function createAxcutChatModel(configService: LlmConfigService) {
  try {
    return await createLangChainModel(undefined, configService.getConfigStore());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} Run \`npm run llm:setup\` to configure Axcut through Yagr.`);
  }
}
