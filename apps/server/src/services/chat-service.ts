import { type ChatInput, chatInputSchema } from '@axcut/schema';

import type { AxcutAgentRuntime } from './axcut-agent-runtime.js';
import type { DatabaseService } from './database.js';
import type { DocumentService } from './document-service.js';
import type { EventBus } from './event-bus.js';

export class ChatService {
  constructor(
    private readonly db: DatabaseService,
    private readonly documents: DocumentService,
    private readonly runtime: AxcutAgentRuntime,
    private readonly events: EventBus,
  ) {}

  async run(projectId: string, input: unknown): Promise<{ assistantMessage: ReturnType<DatabaseService['insertMessage']>; document: ReturnType<DocumentService['getSnapshot']>['document']; sessionId: string }> {
    const payload: ChatInput = chatInputSchema.parse(input);
    const session = payload.sessionId
      ? this.runtime.getSession(projectId, payload.sessionId)
      : this.runtime.getOrCreateSession(projectId);
    const beforeMessageCheckpoint = await this.runtime.saveCheckpoint(projectId, session.id, {
      reason: 'before-message',
      label: 'Before user message',
      summary: payload.message.length > 96 ? `Before "${payload.message.slice(0, 93).trim()}..."` : `Before "${payload.message}"`,
    });
    const userMessage = this.db.insertMessage({ projectId, sessionId: session.id, role: 'user', content: payload.message, revisionId: null, checkpointId: beforeMessageCheckpoint.id });
    this.events.emit(projectId, 'agent.message.user', { sessionId: session.id, messageId: userMessage.id, content: userMessage.content });
    const result = await this.runtime.run(projectId, session.id, payload.message, dbMessagesToAgentHistory(this.db.listMessages(projectId, session.id)));

    const assistant = this.db.insertMessage({
      projectId,
      sessionId: session.id,
      role: 'assistant',
      content: result.summary,
      revisionId: result.revisionId,
    });
    await this.runtime.saveCheckpoint(projectId, session.id, {
      reason: 'after-run',
      label: 'After agent response',
      summary: 'Checkpoint after the agent response.',
    });
    if (result.revisionId) {
      this.events.emit(projectId, 'project.revision.created', { sessionId: session.id, revisionId: result.revisionId });
    }
    this.events.emit(projectId, 'agent.message.assistant', { sessionId: session.id, messageId: assistant.id, content: assistant.content });

    return {
      assistantMessage: assistant,
      document: result.document,
      sessionId: session.id,
    };
  }
}

function dbMessagesToAgentHistory(messages: ReturnType<DatabaseService['listMessages']>) {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'system')
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    }));
}
