import type { AxcutDocument } from '@axcut/schema';

import type { DeepAgentSessionRecord, SessionCheckpointMetadata, SessionCheckpointPayload } from './agent-session-service.js';
import { AxcutDeepAgentService, type AgentConversationMessage } from './axcut-deep-agent.js';
import type { DatabaseService, MessageRow } from './database.js';
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
    private readonly db: DatabaseService,
    private readonly documents: DocumentService,
    private readonly events: EventBus,
    private readonly llmConfig: LlmConfigService,
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

  listCheckpoints(projectId: string, sessionId: string): SessionCheckpointMetadata[] {
    return this.deepAgent.listCheckpoints(projectId, sessionId);
  }

  async saveCheckpoint(
    projectId: string,
    sessionId: string,
    options: { reason?: 'manual' | 'auto' | 'before-message' | 'after-run' | 'before-compaction' | 'after-compaction'; label?: string; summary?: string } = {},
  ): Promise<SessionCheckpointMetadata> {
    const payload = this.buildCheckpointPayload(projectId, sessionId);
    const checkpoint = await this.deepAgent.saveCheckpoint(projectId, sessionId, payload, {
      reason: options.reason ?? 'manual',
      label: options.label ?? 'Manual checkpoint',
      summary: options.summary ?? `Checkpoint with ${payload.messages.length} message${payload.messages.length === 1 ? '' : 's'}.`,
      messageCount: payload.messages.length,
    });
    this.events.emit(projectId, 'agent.checkpoint.saved', { sessionId, checkpointId: checkpoint.id });
    return checkpoint;
  }

  async restoreCheckpoint(projectId: string, sessionId: string, checkpointId: string): Promise<{ checkpoint: SessionCheckpointMetadata; document: AxcutDocument; messages: MessageRow[]; warnings: string[] }> {
    const result = await this.deepAgent.restoreCheckpoint(projectId, sessionId, checkpointId);
    const payload = result.payload;
    if (!payload) {
      if (!result.langGraphRestored) {
        await this.deepAgent.resetRuntimeThread(projectId, sessionId);
      }
      return {
        checkpoint: result.checkpoint,
        document: this.documents.readDocument(projectId),
        messages: this.db.listMessages(projectId, sessionId),
        warnings: result.warnings,
      };
    }
    const document = this.documents.restoreDocument(projectId, payload.document, `Restored checkpoint ${checkpointId}`);
    this.db.replaceMessagesForSession(projectId, sessionId, payload.messages);
    if (!result.langGraphRestored) {
      await this.deepAgent.resetRuntimeThread(projectId, sessionId);
    }
    this.events.emit(projectId, 'agent.checkpoint.restored', { sessionId, checkpointId });
    this.events.emit(projectId, 'project.revision.created', { sessionId, revisionId: document.history.revisions.at(-1)?.id ?? null });
    return {
      checkpoint: result.checkpoint,
      document,
      messages: payload.messages,
      warnings: result.warnings,
    };
  }

  async rewindToMessage(projectId: string, sessionId: string, messageId: string): Promise<{ prompt: string; checkpoint: SessionCheckpointMetadata; document: AxcutDocument; messages: MessageRow[] }> {
    const message = this.db.listMessages(projectId, sessionId).find((item) => item.id === messageId);
    if (!message || message.role !== 'user') {
      throw new Error('Cannot rewind: user message not found.');
    }
    if (!message.checkpointId) {
      throw new Error('Cannot rewind: this message does not have a checkpoint.');
    }
    const restored = await this.restoreCheckpoint(projectId, sessionId, message.checkpointId);
    return {
      prompt: message.content,
      checkpoint: restored.checkpoint,
      document: restored.document,
      messages: restored.messages,
    };
  }

  async deleteCheckpoint(projectId: string, sessionId: string, checkpointId: string): Promise<void> {
    await this.deepAgent.deleteCheckpoint(projectId, sessionId, checkpointId);
    this.events.emit(projectId, 'agent.checkpoint.deleted', { sessionId, checkpointId });
  }

  async compactSession(projectId: string, sessionId: string): Promise<{ summary: string; beforeCheckpoint: SessionCheckpointMetadata; afterCheckpoint: SessionCheckpointMetadata }> {
    const messages = this.db.listMessages(projectId, sessionId);
    const beforeCheckpoint = await this.saveCheckpoint(projectId, sessionId, {
      reason: 'before-compaction',
      label: 'Before context compaction',
      summary: 'Checkpoint before context compaction.',
    });
    const preserved = messages.slice(-4);
    const compacted = messages.slice(0, Math.max(0, messages.length - preserved.length));
    const summary = summarizeMessagesForContext(compacted);
    const now = new Date().toISOString();
    const compactedMessage: MessageRow = {
      id: `msg_compaction_${Date.now().toString(36)}`,
      projectId,
      sessionId,
      role: 'system',
      content: `Context compacted:\n${summary}`,
      revisionId: null,
      checkpointId: null,
      createdAt: now,
    };
    const nextMessages = summary ? [compactedMessage, ...preserved] : preserved;
    this.db.replaceMessagesForSession(projectId, sessionId, nextMessages);
    await this.deepAgent.resetRuntimeThread(projectId, sessionId);
    const afterCheckpoint = await this.saveCheckpoint(projectId, sessionId, {
      reason: 'after-compaction',
      label: 'After context compaction',
      summary: 'Checkpoint after context compaction.',
    });
    this.events.emit(projectId, 'agent.compaction', {
      sessionId,
      summary,
      source: 'fallback',
      messagesCompacted: compacted.length,
      preservedRecentMessages: preserved.length,
    });
    return { summary, beforeCheckpoint, afterCheckpoint };
  }

  getContextUsage(projectId: string, sessionId: string) {
    const promptTokens = estimateTokens(this.db.listMessages(projectId, sessionId).map((message) => message.content).join('\n\n'));
    const contextWindowTokens = 200_000;
    return {
      promptTokens,
      completionTokens: 0,
      contextWindowTokens,
      fillPercent: Math.min(100, Math.round((promptTokens / contextWindowTokens) * 100)),
      source: 'estimated' as const,
    };
  }

  async run(projectId: string, sessionId: string, prompt: string, history: AgentConversationMessage[] = []): Promise<AgentRunResult> {
    const snapshot = this.documents.getSnapshot(projectId).document;
    if (!snapshot.transcript) {
      return {
        summary: 'No transcript is available yet. Attach a video and let Axcut finish ingest first.',
        document: snapshot,
        revisionId: null,
        mode: 'message',
      };
    }

    this.events.emit(projectId, 'agent.phase', {
      phase: 'deepagents',
      message: 'Running the deepagents editing loop',
    });

    const result = await this.deepAgent.invoke(projectId, sessionId, prompt, history);
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

  private buildCheckpointPayload(projectId: string, sessionId: string): SessionCheckpointPayload {
    return {
      version: 1,
      projectId,
      document: this.documents.readDocument(projectId),
      messages: this.db.listMessages(projectId, sessionId),
    };
  }
}

function summarizeMessagesForContext(messages: MessageRow[]): string {
  const text = messages
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return '';
  }
  return text.length > 1800 ? `${text.slice(-1800).trim()}` : text;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
