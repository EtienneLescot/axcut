import path from 'node:path';

import { MemorySaver } from '@langchain/langgraph';
import { SessionService, deriveSessionTitle, type DeepAgentSessionRecord } from '@yagr/session-service';
import { AIMessage, HumanMessage, createAgent, tool } from 'langchain';
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
}).strict();

const suggestCutsToolSchema = z.object({
  kind: z.enum(['filler', 'pause']).describe('Suggestion category to generate.'),
  minDurationSec: z.number().positive().max(5).optional().default(0.6),
  limit: z.number().int().positive().max(12).optional().default(6),
}).strict();

const timelineOperationToolSchema = z.object({
  type: z.enum(['replace_timeline', 'drop_range', 'drop_word_range', 'restore_full_timeline']),
  reason: z.string().default(''),
  intervalsJson: z.string().default('[]').describe('For replace_timeline only: JSON array like [{"startSec":0,"endSec":12.5}] or [[0,12.5]].'),
  startSec: z.number().nonnegative().default(0).describe('For drop_range only.'),
  endSec: z.number().nonnegative().default(0).describe('For drop_range only.'),
  startWordId: z.string().default('').describe('For drop_word_range only.'),
  endWordId: z.string().default('').describe('For drop_word_range only.'),
}).strict();

const suggestionDecisionToolSchema = z.object({
  suggestionId: z.string().min(1),
  reason: z.string().default(''),
}).strict();

type TimelineOperationToolInput = z.infer<typeof timelineOperationToolSchema>;

function buildTimelineOperationFromToolInput(input: TimelineOperationToolInput): AxcutOperation {
  switch (input.type) {
    case 'replace_timeline':
      return {
        type: 'replace_timeline',
        reason: input.reason,
        intervals: parseIntervalsJson(input.intervalsJson),
      };
    case 'drop_range':
      if (input.endSec <= input.startSec) {
        throw new Error('drop_range requires endSec to be greater than startSec.');
      }
      return {
        type: 'drop_range',
        reason: input.reason,
        startSec: input.startSec,
        endSec: input.endSec,
      };
    case 'drop_word_range':
      if (!input.startWordId || !input.endWordId) {
        throw new Error('drop_word_range requires startWordId and endWordId.');
      }
      return {
        type: 'drop_word_range',
        reason: input.reason,
        startWordId: input.startWordId,
        endWordId: input.endWordId,
      };
    case 'restore_full_timeline':
      return {
        type: 'restore_full_timeline',
        reason: input.reason,
      };
  }
}

function parseIntervalsJson(value: string): Array<{ startSec: number; endSec: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || '[]');
  } catch {
    throw new Error('replace_timeline intervalsJson must be valid JSON.');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('replace_timeline intervalsJson must be a JSON array.');
  }

  return parsed.map((item, index) => {
    const interval = Array.isArray(item)
      ? { startSec: item[0], endSec: item[1] }
      : item;
    if (!interval || typeof interval !== 'object') {
      throw new Error(`replace_timeline interval ${index + 1} must be an object or [start,end] pair.`);
    }
    const record = interval as Record<string, unknown>;
    const startSec = record.startSec;
    const endSec = record.endSec;
    if (typeof startSec !== 'number' || typeof endSec !== 'number' || !Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) {
      throw new Error(`replace_timeline interval ${index + 1} must have non-negative startSec and a greater endSec.`);
    }
    return { startSec, endSec };
  });
}

function extractAgentResponseText(result: unknown): string {
  const messages = typeof result === 'object' && result !== null && 'messages' in result
    ? (result as { messages?: unknown }).messages
    : undefined;
  if (!Array.isArray(messages)) {
    return '';
  }

  for (const message of [...messages].reverse()) {
    if (!AIMessage.isInstance(message)) {
      continue;
    }
    return stringifyMessageContent(message.content).trim();
  }
  return '';
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

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

  getOrCreateSession(projectId: string): DeepAgentSessionRecord {
    const document = this.documents.readDocument(projectId);
    const scope = this.projectScope(projectId);
    return this.sessions.getActiveForScope(scope)
      ?? this.sessions.ensure(projectId, { title: document.project.title || 'New conversation', scope });
  }

  createSession(projectId: string): DeepAgentSessionRecord {
    return this.sessions.rotateForScope(this.projectScope(projectId), { title: 'New conversation' });
  }

  getSession(projectId: string, sessionId: string): DeepAgentSessionRecord {
    const existing = this.sessions.get(sessionId);
    if (existing?.scope && (existing.scope.kind !== 'axcut-project' || existing.scope.key !== projectId)) {
      throw new Error(`Session ${sessionId} does not belong to project ${projectId}.`);
    }
    const session = this.sessions.ensure(sessionId, { title: 'New conversation', scope: this.projectScope(projectId) });
    return session;
  }

  listSessions(projectId: string): DeepAgentSessionRecord[] {
    const sessions = this.sessions.listForScope(this.projectScope(projectId));
    return sessions.length ? sessions : [this.getOrCreateSession(projectId)];
  }

  renameSession(projectId: string, sessionId: string, title: string): DeepAgentSessionRecord {
    this.getSession(projectId, sessionId);
    const renamed = this.sessions.touch(sessionId, { title: title.trim() || 'New conversation' });
    if (!renamed) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return renamed;
  }

  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    this.getSession(projectId, sessionId);
    await this.sessions.delete(sessionId);
  }

  async create(projectId: string) {
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
      schema: z.object({}).strict(),
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

    const applyTimelineOperation = tool(async (input) => {
      const operation = buildTimelineOperationFromToolInput(input);
      const result = this.documents.applyOperation(
        projectId,
        operation,
        operation.reason || 'Applied a deepagents timeline operation.',
        'agent',
      );
      return {
        revisionId: result.revisionId,
        timelineClipCount: result.document.timeline.clips.length,
      };
    }, {
      name: 'apply_timeline_operation',
      description: 'Apply a structured timeline mutation directly to the Axcut project. For replace_timeline, pass intervalsJson as a JSON string array of {startSec,endSec} objects or [start,end] pairs.',
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

    return createAgent({
      model: await createAxcutChatModel(this.llmConfig),
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

  async invoke(projectId: string, sessionId: string, prompt: string) {
    const document = this.documents.readDocument(projectId);
    this.getSession(projectId, sessionId);
    await this.restoreLatestCheckpointIfNeeded(sessionId);

    const agent = await this.create(projectId);
    const result = await agent.invoke({
      messages: [new HumanMessage(prompt)],
    }, this.sessions.buildSessionConfig(sessionId));

    await this.sessions.saveCheckpoint(sessionId);
    const currentSession = this.sessions.get(sessionId);
    this.sessions.touch(sessionId, {
      title: currentSession?.title === 'New conversation'
        ? deriveSessionTitle(prompt)
        : currentSession?.title,
    });

    return {
      text: extractAgentResponseText(result) || this.documents.readDocument(projectId).agent.lastReasoningSummary || 'Completed the editing turn.',
      state: result,
    };
  }

  private async restoreLatestCheckpointIfNeeded(sessionId: string): Promise<void> {
    const existing = await this.checkpointer.getTuple(this.sessions.buildSessionConfig(sessionId));
    if (existing) {
      return;
    }

    const latest = this.sessions.listCheckpointsSync(sessionId)[0];
    if (!latest) {
      return;
    }

    await this.sessions.restoreCheckpoint(sessionId, latest.id);
  }

  private projectScope(projectId: string) {
    return { kind: 'axcut-project', key: projectId };
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
