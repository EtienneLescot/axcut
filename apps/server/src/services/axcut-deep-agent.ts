import path from 'node:path';

import { MemorySaver } from '@langchain/langgraph';
import { createDeepAgentRuntime } from '@yagr/deepagent-bootstrap';
import { buildDeepAgentSessionConfig, CheckpointManager, DeepAgentSessionStore } from '@yagr/session-checkpoint';
import { HumanMessage, tool } from 'langchain';
import { z } from 'zod';

import type { AxcutOperation, AxcutSuggestion } from '@axcut/schema';

import { buildFillerSuggestions, buildPauseSuggestions, searchTranscript } from '../lib/structured-agent.js';
import { agentSessionsRoot, projectArtifactsRoot } from '../lib/paths.js';
import { createAxcutChatModel } from '../llm/create-chat-model.js';
import type { DocumentService } from './document-service.js';
import type { PythonWorker } from './python-worker.js';

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

const plannerFallbackToolSchema = z.object({
  prompt: z.string().min(1),
});

export class AxcutDeepAgentService {
  private readonly checkpointer = new MemorySaver();
  private readonly sessionStore = new DeepAgentSessionStore(agentSessionsRoot);
  private readonly checkpointManager = new CheckpointManager(this.checkpointer, agentSessionsRoot);

  constructor(
    private readonly documents: DocumentService,
    private readonly worker: PythonWorker,
  ) {}

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

    const plannerFallback = tool(async ({ prompt }) => {
      const document = getProject();
      if (!document.transcript?.sourceDslPath) {
        return { summary: 'No transcript available for planner fallback.' };
      }
      const artifactsRoot = projectArtifactsRoot(projectId);
      const safeSlug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'plan';
      const cleanedPath = path.join(artifactsRoot, `${safeSlug}-cleaned.axcut`);
      const planPath = path.join(artifactsRoot, `${safeSlug}-plan.json`);
      const intervalsPath = path.join(artifactsRoot, `${safeSlug}-intervals.json`);
      const planned = await this.worker.planPrompt(
        document.transcript.sourceDslPath,
        prompt,
        cleanedPath,
        planPath,
        intervalsPath,
      );
      const summary = typeof planned.data.summary === 'string'
        ? planned.data.summary
        : `Applied ${Array.isArray(planned.data.intervals) ? planned.data.intervals.length : 0} keep intervals from planner fallback.`;
      const result = this.documents.replaceTimeline(
        projectId,
        (planned.data.intervals as Array<{ startSec: number; endSec: number }>) ?? [],
        summary,
        'agent',
      );
      return {
        summary,
        revisionId: result.revisionId,
      };
    }, {
      name: 'run_rewrite_planner',
      description: 'Fallback to the transcript rewrite planner for broad editorial requests that need global reframing.',
      schema: plannerFallbackToolSchema,
    });

    return createDeepAgentRuntime({
      model: createAxcutChatModel(),
      checkpointer: this.checkpointer,
      tools: [
        getProjectState,
        transcriptSearch,
        suggestCuts,
        applyTimelineOperation,
        approveSuggestion,
        rejectSuggestion,
        plannerFallback,
      ],
      systemPrompt: AXCUT_DEEP_AGENT_PROMPT,
    });
  }

  async invoke(projectId: string, prompt: string) {
    const document = this.documents.readDocument(projectId);
    this.sessionStore.ensure(projectId, { title: document.project.title || projectId });
    await this.restoreLatestCheckpointIfNeeded(projectId);

    const agent = this.create(projectId);
    const result = await agent.invoke({
      messages: [new HumanMessage(prompt)],
    }, buildDeepAgentSessionConfig(projectId));

    await this.checkpointManager.saveCheckpoint(projectId);
    this.sessionStore.touch(projectId, { title: document.project.title || projectId });

    return {
      text: extractAssistantText(result.messages),
      state: result,
    };
  }

  private async restoreLatestCheckpointIfNeeded(projectId: string): Promise<void> {
    const existing = await this.checkpointer.getTuple(buildDeepAgentSessionConfig(projectId));
    if (existing) {
      return;
    }

    const latest = this.checkpointManager.listCheckpointsSync(projectId)[0];
    if (!latest) {
      return;
    }

    await this.checkpointManager.restoreCheckpoint(projectId, latest.id);
  }
}

function extractAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return '';
  }
  const lastText = [...messages]
    .reverse()
    .find((message) => {
      if (!message || typeof message !== 'object') return false;
      const candidate = message as { content?: unknown; lc_kwargs?: { content?: unknown } };
      return typeof candidate.content === 'string'
        || typeof candidate.lc_kwargs?.content === 'string';
    });
  if (!lastText || typeof lastText !== 'object') {
    return '';
  }
  const candidate = lastText as { content?: unknown; lc_kwargs?: { content?: unknown } };
  return typeof candidate.content === 'string'
    ? candidate.content
    : typeof candidate.lc_kwargs?.content === 'string'
      ? candidate.lc_kwargs.content
      : '';
}

const AXCUT_DEEP_AGENT_PROMPT = `You are Axcut, an expert agentic video editor.

Your job is to edit a local video project through structured tools rather than by rewriting large files directly.

Rules:
- Always inspect project state before making large editing decisions.
- Prefer transcript search before making assumptions about the user's target passage.
- When the user explicitly asks for options, suggestions, or proposals, use suggest_cuts and do not apply edits immediately.
- When the user gives a direct editing command with clear intent, apply the minimal structured operation needed.
- Use approve_suggestion or reject_suggestion when interacting with existing suggestions.
- Use run_rewrite_planner only when the user asks for broad editorial restructuring that is difficult to express as a few direct operations.
- Keep replies concise and explain what you changed or suggested.
- Never invent transcript content or timestamps.
- Do not ask unnecessary clarifying questions if the existing transcript and project state are sufficient.`;
