import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import type { CoreMessage } from 'ai';
import { YagrSessionAgent, type EngineRuntimePort, type YagrRunOptions, type YagrRunResult } from '@yagr/agent';
import { SessionStore } from '@yagr/agent/dist/session/session-store.js';

import { AxcutRunEngine } from './runner.js';
import { AxcutStateStore } from './state-store.js';

const AXCUT_SYSTEM_PROMPT = [
  'You are Axcut, a local video editing agent.',
  'You help the user cut a video from a transcript and a timeline-aware edit plan.',
  'Favor concrete progress over vague advice.',
  'Use the transcript-analysis workflow first, then ask grounded follow-up questions when the edit is ambiguous.',
  'Do not claim a video is rendered until the render step actually finished.',
  'Keep user-facing replies concise and action-oriented.',
].join(' ');

class DummyAxcutEngine implements EngineRuntimePort {
  readonly name = 'yagr-engine' as const;

  async searchNodes(): Promise<never[]> { return []; }
  async nodeInfo(): Promise<Record<string, never>> { return {}; }
  async searchTemplates(): Promise<never[]> { return []; }
  async deploy(): Promise<never> { throw new Error('deploy is not used by Axcut'); }
  async listWorkflows(): Promise<never[]> { return []; }
  async activateWorkflow(): Promise<void> {}
  async deactivateWorkflow(): Promise<void> {}
  async deleteWorkflow(): Promise<void> {}
}

class PersistedAxcutSessionAgent extends YagrSessionAgent {
  constructor(
    runtimeEngine: EngineRuntimePort,
    private readonly sessionId: string,
    private readonly sessionStore: SessionStore,
    private readonly stateStore: AxcutStateStore,
    private readonly workspaceRoot: string,
    initialHistory: readonly CoreMessage[] = [],
  ) {
    super(runtimeEngine, {
      initialHistory,
      buildPromptSnapshot: () => ({
        systemPrompt: AXCUT_SYSTEM_PROMPT,
        workspaceInstructions: {
          path: path.join(workspaceRoot, 'AGENTS.md'),
          content: AXCUT_SYSTEM_PROMPT,
          fingerprint: createHash('sha256').update(AXCUT_SYSTEM_PROMPT).digest('hex'),
        },
      }),
      createRunner: (_engine, history, systemPrompt) => new AxcutRunEngine({
        workspaceRoot,
        sessionId,
        history,
        stateStore,
      }),
    });
  }

  override async run(prompt: string, options: YagrRunOptions = {}): Promise<YagrRunResult> {
    const result = await super.run(prompt, options);
    this.sessionStore.persistRun(this.sessionId, 'tui', [...this.messages]);
    return result;
  }
}

export function createPersistedAgent(workspaceRoot: string): {
  agent: PersistedAxcutSessionAgent;
  sessionId: string;
  sessionStore: SessionStore;
  stateStore: AxcutStateStore;
  initialMessages: readonly CoreMessage[];
} {
  const sessionRoot = path.join(workspaceRoot, '.axcut-ui');
  const sessionsDir = path.join(sessionRoot, 'sessions');
  const stateDir = path.join(sessionRoot, 'state');
  const sessionStore = new SessionStore(sessionsDir);
  const stateStore = new AxcutStateStore(stateDir);
  const persisted = sessionStore.findLatestByGatewayKey('tui', 'tui');
  const sessionId = persisted?.id ?? randomUUID();

  if (!persisted) {
    sessionStore.createEmpty('tui', sessionId);
  }
  sessionStore.setActiveSessionId('tui', sessionId);

  const agent = new PersistedAxcutSessionAgent(
    new DummyAxcutEngine(),
    sessionId,
    sessionStore,
    stateStore,
    workspaceRoot,
    persisted?.messages ?? [],
  );

  return {
    agent,
    sessionId,
    sessionStore,
    stateStore,
    initialMessages: persisted?.messages ?? [],
  };
}
