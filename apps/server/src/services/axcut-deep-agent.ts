import path from 'node:path';

import { MemorySaver } from '@langchain/langgraph';
import { createDeepAgentRuntime } from '@yagr/deepagent-bootstrap';
import type { RuntimeContextCompactionEvent, RuntimeOperationEvent } from '@yagr/runtime-events';
import { SessionService } from '@yagr/session-service';
import { consumeLangGraphStream } from '@yagr/stream-adapter';
import { HumanMessage, tool } from 'langchain';
import { z } from 'zod';

import type { AxcutOperation, AxcutSuggestion } from '@axcut/schema';

import { buildFillerSuggestions, buildPauseSuggestions, searchTranscript } from '../lib/structured-agent.js';
import { agentSessionsRoot, dataRoot } from '../lib/paths.js';
import { createAxcutChatModel } from '../llm/create-chat-model.js';
import type { DocumentService } from './document-service.js';
import type { EventBus } from './event-bus.js';
import type { LlmConfigService } from './llm-config-service.js';

const searchTranscriptToolSchema = z.object({
  query: z.string().min(1).describe('Search query to locate transcript passages.'),
  limit: z.number().int().positive().max(12).optional().default(8),
});

const suggestCutsToolSchema = z.object({
  kind: z.enum(['filler', 'pause']).describe('Suggestion category to generate.'),
  minDurationSec: z.number().positive().max(5).optional().default(0.6),
  limit: z.number().int().positive().max(12).optional().default(6),
});

const timelineOperationToolSchema = z.object({
  operation: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('replace_timeline'),
      reason: z.string().default(''),
      intervals: z.array(z.object({ startSec: z.number().nonnegative(), endSec: z.number().nonnegative() })),
    }),
    z.object({
      type: z.literal('drop_range'),
      reason: z.string().default(''),
      startSec: z.number().nonnegative(),
      endSec: z.number().nonnegative(),
    }),
    z.object({
      type: z.literal('drop_word_range'),
      reason: z.string().default(''),
      startWordId: z.string().min(1),
      endWordId: z.string().min(1),
    }),
    z.object({
      type: z.literal('restore_full_timeline'),
      reason: z.string().default(''),
    }),
  ]),
});

const suggestionDecisionToolSchema = z.object({
  suggestionId: z.string().min(1),
  reason: z.string().default(''),
});

export class AxcutDeepAgentService {
  private readonly checkpointer = new MemorySaver();
  private readonly sessions = new SessionService({
    sessionsDir: agentSessionsRoot,
    webUiSessionsDir: path.join(dataRoot, 'ui-sessions'),
  });

  constructor(
    private readonly documents: DocumentService,
    private readonly events: EventBus,
    private readonly llmConfig: LlmConfigService,
  ) {
    this.sessions.setCheckpointer(this.checkpointer);
  }

  create(projectId: string) {
    const getProject = () => this.documents.readDocument(projectId);

    const getProjectState = tool(async () => {
      const document = getProject();
      return {
        project: document.project,
        assets: document.assets.map((asset) => ({
          id: asset.id,
          label: asset.label,
          durationSec: asset.durationSec ?? 0,
          hasProxy: Boolean(asset.proxyPath),
        })),
        timeline: document.timeline.clips.map((clip) => ({
          id: clip.id,
          sourceStartSec: clip.sourceStartSec,
          sourceEndSec: clip.sourceEndSec,
          timelineStartSec: clip.timelineStartSec,
          timelineEndSec: clip.timelineEndSec,
          reason: clip.reason,
        })),
        transcriptSummary: document.transcript
          ? {
              language: document.transcript.language,
              segmentCount: document.transcript.segments.length,
              wordCount: document.transcript.words.length,
            }
          : null,
        suggestions: document.agent.suggestions,
      };
    }, {
      name: 'get_project_state',
      description: 'Read the current Axcut project state, timeline, transcript metadata, and existing suggestions.',
      schema: z.object({}),
    });

    const transcriptSearch = tool(async ({ query, limit }) => {
      const document = getProject();
      return searchTranscript(document, query, limit);
    }, {
      name: 'search_transcript',
      description: 'Search the transcript for passages relevant to the user request.',
      schema: searchTranscriptToolSchema,
    });

    const suggestCuts = tool(async ({ kind, minDurationSec, limit }) => {
      const document = getProject();
      const suggestions = (kind === 'filler'
        ? buildFillerSuggestions(document)
        : buildPauseSuggestions(document, minDurationSec))
        .slice(0, limit);
      this.documents.setSuggestions(projectId, suggestions, `Prepared ${suggestions.length} ${kind} suggestion${suggestions.length === 1 ? '' : 's'}.`);
      return {
        count: suggestions.length,
        suggestions,
      };
    }, {
      name: 'suggest_cuts',
      description: 'Create structured cut suggestions and persist them in the project for later approval or rejection.',
      schema: suggestCutsToolSchema,
    });

    const applyTimelineOperation = tool(async ({ operation }) => {
      const result = this.documents.applyOperation(
        projectId,
        operation as AxcutOperation,
        operation.reason || 'Applied a deepagents timeline operation.',
        'agent',
      );
      return {
        revisionId: result.revisionId,
        timelineClipCount: result.document.timeline.clips.length,
      };
    }, {
      name: 'apply_timeline_operation',
      description: 'Apply a structured timeline mutation directly to the Axcut project.',
      schema: timelineOperationToolSchema,
    });

    const approveSuggestion = tool(async ({ suggestionId, reason }) => {
      const result = this.documents.applyOperation(projectId, {
        type: 'approve_suggestion',
        suggestionId,
        reason,
      }, reason || 'Approved a suggested cut.', 'agent');
      return {
        revisionId: result.revisionId,
        suggestionId,
      };
    }, {
      name: 'approve_suggestion',
      description: 'Approve a previously generated suggestion and apply its proposed operation.',
      schema: suggestionDecisionToolSchema,
    });

    const rejectSuggestion = tool(async ({ suggestionId, reason }) => {
      const result = this.documents.applyOperation(projectId, {
        type: 'reject_suggestion',
        suggestionId,
        reason,
      }, reason || 'Rejected a suggested cut.', 'agent');
      return {
        revisionId: result.revisionId,
        suggestionId,
      };
    }, {
      name: 'reject_suggestion',
      description: 'Reject a previously generated cut suggestion without changing the timeline.',
      schema: suggestionDecisionToolSchema,
    });

    return createDeepAgentRuntime({
      model: createAxcutChatModel(this.llmConfig),
      checkpointer: this.checkpointer,
      tools: [
        getProjectState,
        transcriptSearch,
        suggestCuts,
        applyTimelineOperation,
        approveSuggestion,
        rejectSuggestion,
      ],
      systemPrompt: AXCUT_DEEP_AGENT_PROMPT,
    });
  }

  async invoke(projectId: string, prompt: string) {
    const document = this.documents.readDocument(projectId);
    this.sessions.ensure(projectId, { title: document.project.title || projectId });
    await this.restoreLatestCheckpointIfNeeded(projectId);

    const agent = this.create(projectId);
    const stream = agent.streamEvents({
      messages: [new HumanMessage(prompt)],
    }, this.sessions.buildSessionConfig(projectId));

    const result = await consumeLangGraphStream(stream, {
      onTextDelta: async (delta: string) => {
        this.events.emit(projectId, 'agent.message.delta', { delta });
      },
      onThinkingDelta: async (delta: string) => {
        this.events.emit(projectId, 'agent.thinking.delta', { delta });
      },
      onOperation: async (operation: RuntimeOperationEvent) => {
        this.events.emit(projectId, 'agent.operation', { operation });
      },
      onCompaction: async (compaction: RuntimeContextCompactionEvent) => {
        this.events.emit(projectId, 'agent.compaction', { compaction });
      },
    });

    await this.sessions.saveCheckpoint(projectId);
    this.sessions.touch(projectId, { title: document.project.title || projectId });

    return {
      text: result.responseText || this.documents.readDocument(projectId).agent.lastReasoningSummary || 'Completed the deepagents editing turn.',
      state: result,
    };
  }

  private async restoreLatestCheckpointIfNeeded(projectId: string): Promise<void> {
    const existing = await this.checkpointer.getTuple(this.sessions.buildSessionConfig(projectId));
    if (existing) {
      return;
    }

    const latest = this.sessions.listCheckpointsSync(projectId)[0];
    if (!latest) {
      return;
    }

    await this.sessions.restoreCheckpoint(projectId, latest.id);
  }
}

const AXCUT_DEEP_AGENT_PROMPT = `You are Axcut, an expert agentic video editor.

Your job is to edit a local video project through structured tools rather than by rewriting large files directly.

Rules:
- Always inspect project state before making large editing decisions.
- Prefer transcript search before making assumptions about the user's target passage.
- When the user explicitly asks for options, suggestions, or proposals, use suggest_cuts and do not apply edits immediately.
- When the user gives a direct editing command with clear intent, apply the minimal structured operation needed.
- Use approve_suggestion or reject_suggestion when interacting with existing suggestions.
- Keep replies concise and explain what you changed or suggested.
- Never invent transcript content or timestamps.
- Do not ask unnecessary clarifying questions if the existing transcript and project state are sufficient.`;
