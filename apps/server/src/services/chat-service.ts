import path from 'node:path';

import { type ChatInput, chatInputSchema } from '@axcut/schema';

import { projectArtifactsRoot } from '../lib/paths.js';
import type { DatabaseService } from './database.js';
import type { DocumentService } from './document-service.js';
import type { EventBus } from './event-bus.js';
import type { PythonWorker } from './python-worker.js';

export class ChatService {
  constructor(
    private readonly db: DatabaseService,
    private readonly documents: DocumentService,
    private readonly worker: PythonWorker,
    private readonly events: EventBus,
  ) {}

  async run(projectId: string, input: unknown): Promise<{ assistantMessage: ReturnType<DatabaseService['insertMessage']>; document: ReturnType<DocumentService['getSnapshot']>['document'] }> {
    const payload: ChatInput = chatInputSchema.parse(input);
    const userMessage = this.db.insertMessage({ projectId, role: 'user', content: payload.message, revisionId: null });
    this.events.emit(projectId, 'agent.message.user', { messageId: userMessage.id, content: userMessage.content });

    const snapshot = this.documents.getSnapshot(projectId).document;
    if (!snapshot.transcript?.sourceDslPath) {
      const assistant = this.db.insertMessage({
        projectId,
        role: 'assistant',
        content: 'No transcript is available yet. Attach a video and let Axcut finish ingest first.',
        revisionId: null,
      });
      this.events.emit(projectId, 'agent.message.assistant', { messageId: assistant.id, content: assistant.content });
      return { assistantMessage: assistant, document: snapshot };
    }

    this.events.emit(projectId, 'agent.phase', { phase: 'planning', message: 'Generating a new cut plan from the prompt' });

    const artifactsRoot = projectArtifactsRoot(projectId);
    const cleanedPath = path.join(artifactsRoot, `${userMessage.id}-cleaned.axcut`);
    const planPath = path.join(artifactsRoot, `${userMessage.id}-plan.json`);
    const intervalsPath = path.join(artifactsRoot, `${userMessage.id}-intervals.json`);

    const planned = await this.worker.planPrompt(
      snapshot.transcript.sourceDslPath,
      payload.message,
      cleanedPath,
      planPath,
      intervalsPath,
    );

    const summary = typeof planned.data.summary === 'string'
      ? planned.data.summary
      : `Applied ${Array.isArray(planned.data.intervals) ? planned.data.intervals.length : 0} keep intervals from the latest prompt.`;
    const replaceResult = this.documents.replaceTimeline(projectId, (planned.data.intervals as Array<{ startSec: number; endSec: number }>) ?? [], summary, 'agent');

    const assistant = this.db.insertMessage({
      projectId,
      role: 'assistant',
      content: summary,
      revisionId: replaceResult.revisionId,
    });
    this.events.emit(projectId, 'project.revision.created', { revisionId: replaceResult.revisionId });
    this.events.emit(projectId, 'agent.message.assistant', { messageId: assistant.id, content: assistant.content });

    return {
      assistantMessage: assistant,
      document: replaceResult.document,
    };
  }
}
