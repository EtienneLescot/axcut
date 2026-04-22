import { ChatOpenAI } from '@langchain/openai';

export function createAxcutChatModel() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for the deepagents runtime.');
  }

  return new ChatOpenAI({
    apiKey,
    model: process.env.AXCUT_AGENT_MODEL?.trim() || 'gpt-5.4',
    temperature: 0,
    ...(process.env.OPENAI_BASE_URL?.trim()
      ? { configuration: { baseURL: process.env.OPENAI_BASE_URL.trim() } }
      : {}),
  });
}
