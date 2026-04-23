import type { AxcutDocument } from '@axcut/schema';

import { AxcutDeepAgentService } from './axcut-deep-agent.js';
import type { DocumentService } from './document-service.js';
import type { EventBus } from './event-bus.js';

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
  ) {
    this.deepAgent = new AxcutDeepAgentService(documents, events);
  }

  async run(projectId: string, prompt: string): Promise<AgentRunResult> {
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

    const result = await this.deepAgent.invoke(projectId, prompt);
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
}
