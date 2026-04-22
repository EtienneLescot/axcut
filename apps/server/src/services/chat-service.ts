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

  async run(projectId: string, input: unknown): Promise<{ assistantMessage: ReturnType<DatabaseService['insertMessage']>; document: ReturnType<DocumentService['getSnapshot']>['document'] }> {
    const payload: ChatInput = chatInputSchema.parse(input);
    const userMessage = this.db.insertMessage({ projectId, role: 'user', content: payload.message, revisionId: null });
    this.events.emit(projectId, 'agent.message.user', { messageId: userMessage.id, content: userMessage.content });
    const result = await this.runtime.run(projectId, payload.message);

    const assistant = this.db.insertMessage({
      projectId,
      role: 'assistant',
      content: result.summary,
      revisionId: result.revisionId,
    });
    if (result.revisionId) {
      this.events.emit(projectId, 'project.revision.created', { revisionId: result.revisionId });
    }
    this.events.emit(projectId, 'agent.message.assistant', { messageId: assistant.id, content: assistant.content });

    return {
      assistantMessage: assistant,
      document: result.document,
    };
  }
}
