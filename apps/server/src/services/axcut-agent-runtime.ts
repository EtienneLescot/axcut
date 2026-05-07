import type { AxcutDocument } from '@axcut/schema';
import type { DeepAgentSessionRecord } from '@yagr/session-service';

import { interpretPrompt, type RuntimeIntent } from '../lib/structured-agent.js';
import { AxcutDeepAgentService } from './axcut-deep-agent.js';
import type { DocumentService } from './document-service.js';
import type { EventBus } from './event-bus.js';
import type { LlmConfigService } from './llm-config-service.js';

export type AgentRunResult = {
  summary: string;
  document: AxcutDocument;
  revisionId: string | null;
  mode: 'message' | 'deepagents';
};

export class AxcutAgentRuntime {
  private readonly deepAgent: AxcutDeepAgentService;

  constructor(
    private readonly documents: DocumentService,
    private readonly events: EventBus,
    llmConfig: LlmConfigService,
  ) {
    this.deepAgent = new AxcutDeepAgentService(documents, events, llmConfig);
  }

  getOrCreateSession(projectId: string): DeepAgentSessionRecord {
    return this.deepAgent.getOrCreateSession(projectId);
  }

  createSession(projectId: string): DeepAgentSessionRecord {
    return this.deepAgent.createSession(projectId);
  }

  getSession(projectId: string, sessionId: string): DeepAgentSessionRecord {
    return this.deepAgent.getSession(projectId, sessionId);
  }

  listSessions(projectId: string): DeepAgentSessionRecord[] {
    return this.deepAgent.listSessions(projectId);
  }

  renameSession(projectId: string, sessionId: string, title: string): DeepAgentSessionRecord {
    return this.deepAgent.renameSession(projectId, sessionId, title);
  }

  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    await this.deepAgent.deleteSession(projectId, sessionId);
  }

  async run(projectId: string, sessionId: string, prompt: string): Promise<AgentRunResult> {
    const snapshot = this.documents.getSnapshot(projectId).document;
    if (!snapshot.transcript) {
      return {
        summary: 'No transcript is available yet. Attach a video and let Axcut finish ingest first.',
        document: snapshot,
        revisionId: null,
        mode: 'message',
      };
    }

    const structuredIntent = interpretPrompt(snapshot, prompt);
    if (structuredIntent) {
      this.events.emit(projectId, 'agent.phase', {
        phase: 'structured',
        message: 'Applying a structured transcript edit',
      });
      return this.runStructuredIntent(projectId, snapshot, structuredIntent);
    }

    this.events.emit(projectId, 'agent.phase', {
      phase: 'deepagents',
      message: 'Running the deepagents editing loop',
    });

    const result = await this.deepAgent.invoke(projectId, sessionId, prompt);
    const document = this.documents.readDocument(projectId);
    const revisionId = document.history.revisions.length > snapshot.history.revisions.length
      ? document.history.revisions.at(-1)?.id ?? null
      : null;

    return {
      summary: result.text || 'Completed the deepagents editing turn.',
      document,
      revisionId,
      mode: 'deepagents',
    };
  }

  private runStructuredIntent(projectId: string, snapshot: AxcutDocument, intent: RuntimeIntent): AgentRunResult {
    switch (intent.kind) {
      case 'restore': {
        const result = this.documents.applyOperation(projectId, intent.operation, intent.summary, 'agent');
        return {
          summary: intent.summary,
          document: result.document,
          revisionId: result.revisionId,
          mode: 'message',
        };
      }
      case 'apply': {
        const result = this.documents.replaceTimeline(projectId, intent.intervals, intent.summary, 'agent');
        return {
          summary: intent.summary,
          document: result.document,
          revisionId: result.revisionId,
          mode: 'message',
        };
      }
      case 'suggest': {
        const document = this.documents.setSuggestions(projectId, intent.suggestions, intent.summary);
        return {
          summary: intent.summary,
          document,
          revisionId: null,
          mode: 'message',
        };
      }
      case 'message':
        return {
          summary: intent.summary,
          document: snapshot,
          revisionId: null,
          mode: 'message',
        };
    }
  }
}
