import path from 'node:path';

import type { AxcutDocument } from '@axcut/schema';

import { projectArtifactsRoot } from '../lib/paths.js';
import { interpretPrompt } from '../lib/structured-agent.js';
import { AxcutDeepAgentService } from './axcut-deep-agent.js';
import type { DocumentService } from './document-service.js';
import type { EventBus } from './event-bus.js';
import type { PythonWorker } from './python-worker.js';

export type AgentRunResult = {
  summary: string;
  document: AxcutDocument;
  revisionId: string | null;
  mode: 'message' | 'structured-apply' | 'structured-suggest' | 'planner';
};

export class AxcutAgentRuntime {
  private readonly deepAgent: AxcutDeepAgentService;

  constructor(
    private readonly documents: DocumentService,
    private readonly worker: PythonWorker,
    private readonly events: EventBus,
  ) {
    this.deepAgent = new AxcutDeepAgentService(documents, worker);
  }

  async run(projectId: string, prompt: string): Promise<AgentRunResult> {
    const snapshot = this.documents.getSnapshot(projectId).document;
    if (!snapshot.transcript?.sourceDslPath) {
      const structured = this.tryStructured(projectId, snapshot, prompt);
      if (structured) {
        return structured;
      }
      return {
        summary: 'No transcript is available yet. Attach a video and let Axcut finish ingest first.',
        document: snapshot,
        revisionId: null,
        mode: 'message',
      };
    }

    try {
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
        mode: 'structured-apply',
      };
    } catch (error) {
      this.events.emit(projectId, 'agent.phase', {
        phase: 'deepagents-fallback',
        message: error instanceof Error
          ? `Deepagents runtime failed, falling back to local planner: ${error.message}`
          : 'Deepagents runtime failed, falling back to local planner.',
      });
    }

    const structured = this.tryStructured(projectId, snapshot, prompt);
    if (structured) {
      return structured;
    }

    this.events.emit(projectId, 'agent.phase', {
      phase: 'planning',
      message: 'Generating a new cut plan from the prompt',
    });

    const artifactsRoot = projectArtifactsRoot(projectId);
    const safeSlug = prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'plan';
    const cleanedPath = path.join(artifactsRoot, `${safeSlug}-cleaned.axcut`);
    const planPath = path.join(artifactsRoot, `${safeSlug}-plan.json`);
    const intervalsPath = path.join(artifactsRoot, `${safeSlug}-intervals.json`);

    const planned = await this.worker.planPrompt(
      snapshot.transcript.sourceDslPath,
      prompt,
      cleanedPath,
      planPath,
      intervalsPath,
    );

    const summary = typeof planned.data.summary === 'string'
      ? planned.data.summary
      : `Applied ${Array.isArray(planned.data.intervals) ? planned.data.intervals.length : 0} keep intervals from the latest prompt.`;
    const replaceResult = this.documents.replaceTimeline(
      projectId,
      (planned.data.intervals as Array<{ startSec: number; endSec: number }>) ?? [],
      summary,
      'agent',
    );

    return {
      summary,
      document: replaceResult.document,
      revisionId: replaceResult.revisionId,
      mode: 'planner',
    };
  }

  private tryStructured(projectId: string, snapshot: AxcutDocument, prompt: string): AgentRunResult | null {
    const intent = interpretPrompt(snapshot, prompt);
    if (!intent) {
      return null;
    }

    if (intent.kind === 'message') {
      return {
        summary: intent.summary,
        document: snapshot,
        revisionId: null,
        mode: 'message',
      };
    }

    if (intent.kind === 'suggest') {
      this.events.emit(projectId, 'agent.phase', {
        phase: 'structured-suggest',
        message: 'Preparing structured cut suggestions from the transcript',
      });
      const document = this.documents.setSuggestions(projectId, intent.suggestions, intent.summary);
      return {
        summary: intent.summary,
        document,
        revisionId: null,
        mode: 'structured-suggest',
      };
    }

    if (intent.kind === 'apply') {
      this.events.emit(projectId, 'agent.phase', {
        phase: 'structured-apply',
        message: 'Applying structured timeline operations from the transcript',
      });
      const result = this.documents.replaceTimeline(projectId, intent.intervals, intent.summary, 'agent');
      return {
        summary: intent.summary,
        document: result.document,
        revisionId: result.revisionId,
        mode: 'structured-apply',
      };
    }

    this.events.emit(projectId, 'agent.phase', {
      phase: 'structured-apply',
      message: 'Applying a structured timeline operation',
    });
    const result = this.documents.applyOperation(projectId, intent.operation, intent.summary, 'agent');
    return {
      summary: intent.summary,
      document: result.document,
      revisionId: result.revisionId,
      mode: 'structured-apply',
    };
  }
}
