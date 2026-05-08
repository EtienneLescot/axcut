import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { MemorySaver } from '@langchain/langgraph';
import { SessionService, deriveSessionTitle, type DeepAgentSessionRecord } from '@yagr/session-service';
import { AIMessage, HumanMessage, SystemMessage, createAgent, tool } from 'langchain';
import { z } from 'zod';

import type { AxcutDocument, AxcutOperation, AxcutSuggestion } from '@axcut/schema';

import { buildFillerSuggestions, buildPauseSuggestions, searchTranscript } from '../lib/structured-agent.js';
import { normalizeIntervals, timelineIntervals } from '../lib/timeline.js';
import { agentSessionsRoot, dataRoot } from '../lib/paths.js';
import { createAxcutChatModel } from '../llm/create-chat-model.js';
import type { DocumentService } from './document-service.js';
import type { EventBus } from './event-bus.js';
import type { LlmConfigService } from './llm-config-service.js';

export type AgentConversationMessage = {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
};

const nullableString = z.string().nullable().default(null);

const searchTranscriptToolSchema = z.object({
  query: z.string().min(1).describe('Search query to locate transcript passages.'),
  limit: z.number().int().positive().max(12).nullable().default(null),
}).strict();

const suggestCutsToolSchema = z.object({
  kind: z.string().min(1).describe('Suggestion category to generate: "filler" or "pause".'),
  minDurationSec: z.number().positive().max(5).nullable().default(null),
  limit: z.number().int().positive().max(12).nullable().default(null),
}).strict();

const timelineOperationToolSchema = z.object({
  type: z.string().min(1).describe('Operation type: "replace_timeline", "drop_range", "drop_word_range", or "restore_full_timeline".'),
  reason: nullableString,
  intervalsJson: nullableString.describe('For replace_timeline only: JSON array like [{"startSec":0,"endSec":12.5}] or [[0,12.5]].'),
  startSec: z.number().nonnegative().nullable().default(null).describe('For drop_range only.'),
  endSec: z.number().nonnegative().nullable().default(null).describe('For drop_range only.'),
  startWordId: nullableString.describe('For drop_word_range only.'),
  endWordId: nullableString.describe('For drop_word_range only.'),
}).strict();

const suggestionDecisionToolSchema = z.object({
  suggestionId: z.string().min(1),
  reason: nullableString,
}).strict();

const MAX_CONTEXT_SEGMENTS = 240;
const MAX_CONTEXT_WORDS = 800;

type TimelineOperationToolInput = z.infer<typeof timelineOperationToolSchema>;

function withDefault<T>(value: T | null | undefined, defaultValue: T): T {
  return value ?? defaultValue;
}

function buildTimelineOperationFromToolInput(input: TimelineOperationToolInput): AxcutOperation {
  const reason = withDefault(input.reason, '');
  switch (input.type) {
    case 'replace_timeline':
      return {
        type: 'replace_timeline',
        reason,
        intervals: parseIntervalsJson(withDefault(input.intervalsJson, '[]')),
      };
    case 'drop_range':
      if (withDefault(input.endSec, 0) <= withDefault(input.startSec, 0)) {
        throw new Error('drop_range requires endSec to be greater than startSec.');
      }
      return {
        type: 'drop_range',
        reason,
        startSec: withDefault(input.startSec, 0),
        endSec: withDefault(input.endSec, 0),
      };
    case 'drop_word_range':
      if (!input.startWordId || !input.endWordId) {
        throw new Error('drop_word_range requires startWordId and endWordId.');
      }
      return {
        type: 'drop_word_range',
        reason,
        startWordId: input.startWordId,
        endWordId: input.endWordId,
      };
    case 'restore_full_timeline':
      return {
        type: 'restore_full_timeline',
        reason,
      };
    default:
      throw new Error(`Unknown timeline operation type "${input.type}".`);
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

function safeStringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(value: string, maxLength = 4000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function humanizeToolName(name: string): string {
  return name
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ') || 'Tool';
}

function extractStreamText(event: Record<string, unknown>): string {
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
  const chunk = data.chunk && typeof data.chunk === 'object' ? data.chunk as Record<string, unknown> : undefined;
  const content = chunk && 'content' in chunk ? chunk.content : undefined;
  return stringifyMessageContent(content);
}

function extractResponseFromStreamEnd(event: Record<string, unknown>): unknown {
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : undefined;
  const output = data?.output;
  return output && typeof output === 'object' && 'messages' in output ? output : null;
}

export function buildAgentInputMessages(prompt: string, history: AgentConversationMessage[] = [], invocationPrompt = prompt) {
  const messages = history
    .filter((message) => message.content.trim())
    .map((message) => {
      const isCurrentUserMessage = message.role === 'user' && message.content === prompt;
      const fields = { content: isCurrentUserMessage ? invocationPrompt : message.content, id: message.id };
      if (message.role === 'assistant') {
        return new AIMessage(fields);
      }
      if (message.role === 'system') {
        return new SystemMessage(fields);
      }
      return new HumanMessage(fields);
    });

  const lastUserMessage = [...history].reverse().find((message) => message.role === 'user');
  if (!lastUserMessage || lastUserMessage.content !== prompt) {
    messages.push(new HumanMessage(invocationPrompt));
  }

  return messages.length > 0 ? messages : [new HumanMessage(invocationPrompt)];
}

export function buildAxcutInvocationPrompt(document: AxcutDocument, prompt: string): string {
  const speechKeepIntervals = buildSpeechKeepIntervals(document);
  const firstSpeechRange = findFirstCurrentSpeechRange(document);
  const transcriptSegments = document.transcript?.segments.slice(0, MAX_CONTEXT_SEGMENTS).map((segment) => ({
    id: segment.id,
    kind: segment.kind,
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text,
    wordIds: segment.wordIds,
  })) ?? [];
  const transcriptTruncated = (document.transcript?.segments.length ?? 0) > transcriptSegments.length;
  const wordContext = buildCurrentTimelineWordContext(document);
  const context = {
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
    transcript: document.transcript
      ? {
          language: document.transcript.language,
          segmentCount: document.transcript.segments.length,
          wordCount: document.transcript.words.length,
          truncated: transcriptTruncated,
          segments: transcriptSegments,
          words: wordContext.words,
          wordsScope: 'current_timeline_source_words',
          wordsTruncated: wordContext.truncated,
        }
      : null,
    suggestions: document.agent.suggestions,
    operationHints: {
      speechKeepIntervalsForNonSpeakingRemoval: speechKeepIntervals,
      firstCurrentSpeechRange: firstSpeechRange,
    },
  };

  return [
    'Axcut project context for this turn:',
    JSON.stringify(context),
    '',
    'Operation guidance:',
    '- The LLM must decide whether an edit is appropriate. Do not edit unless the user requested it.',
    '- For removing non-speaking/silence ranges, call apply_timeline_operation with type "replace_timeline" and intervalsJson set to operationHints.speechKeepIntervalsForNonSpeakingRemoval.',
    '- For removing the first phrase/first spoken segment, call apply_timeline_operation with type "drop_range" using operationHints.firstCurrentSpeechRange.',
    '- For removing exact words or phrases, use transcript.words or search_transcript word ids/timestamps, then call apply_timeline_operation with type "drop_word_range" using startWordId and endWordId.',
    '- search_transcript returns source transcript segments plus word ids/timestamps and exact phrase matches when available.',
    '- The transcript context is the canonical source transcript with source timestamps. The UI timeline transcript is only a reconstruction of the current clips.',
    '- If the requested edit is not covered by operationHints, derive the minimal operation from the source timeline/transcript context or use search_transcript first.',
    '',
    'User request:',
    prompt,
  ].join('\n');
}

function buildCurrentTimelineWordContext(document: AxcutDocument): { words: Array<{ id: string; segmentId: string; startSec: number; endSec: number; text: string }>; truncated: boolean } {
  const transcript = document.transcript;
  if (!transcript) {
    return { words: [], truncated: false };
  }

  const intervals = timelineIntervals(document);
  const scopedWords = intervals.length > 0
    ? transcript.words.filter((word) => intervals.some((interval) => word.endSec > interval.startSec && word.startSec < interval.endSec))
    : transcript.words;
  return {
    words: scopedWords.slice(0, MAX_CONTEXT_WORDS).map((word) => ({
      id: word.id,
      segmentId: word.segmentId,
      startSec: word.startSec,
      endSec: word.endSec,
      text: word.text,
    })),
    truncated: scopedWords.length > MAX_CONTEXT_WORDS,
  };
}

function buildSpeechKeepIntervals(document: AxcutDocument): Array<{ startSec: number; endSec: number }> {
  const transcript = document.transcript;
  if (!transcript) {
    return [];
  }
  const currentIntervals = timelineIntervals(document);
  const speechSegments = transcript.segments.filter((segment) => segment.kind === 'speech' && segment.endSec > segment.startSec);
  const intersections: Array<{ startSec: number; endSec: number }> = [];
  for (const segment of speechSegments) {
    for (const interval of currentIntervals) {
      const startSec = Math.max(segment.startSec, interval.startSec);
      const endSec = Math.min(segment.endSec, interval.endSec);
      if (endSec > startSec) {
        intersections.push({ startSec, endSec });
      }
    }
  }
  return normalizeIntervals(primaryDuration(document), intersections);
}

function findFirstCurrentSpeechRange(document: AxcutDocument): { startSec: number; endSec: number } | null {
  const transcript = document.transcript;
  if (!transcript) {
    return null;
  }
  const currentIntervals = timelineIntervals(document);
  for (const segment of [...transcript.segments].filter((item) => item.kind === 'speech').sort((left, right) => left.startSec - right.startSec)) {
    for (const interval of currentIntervals) {
      const startSec = Math.max(segment.startSec, interval.startSec);
      const endSec = Math.min(segment.endSec, interval.endSec);
      if (endSec > startSec) {
        return { startSec, endSec };
      }
    }
  }
  return null;
}

function primaryDuration(document: AxcutDocument): number {
  const asset = document.assets.find((item) => item.id === document.project.primaryAssetId) ?? document.assets[0];
  return asset?.durationSec ?? 0;
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

    const transcriptSearch = tool(async ({ query, limit }) => {
      const document = getProject();
      return searchTranscript(document, query, withDefault(limit, 8));
    }, {
      name: 'search_transcript',
      description: 'Search the current timeline scope of the source transcript. Returns matching segments, word ids, source word timestamps, and exact phrase matches when available.',
      schema: searchTranscriptToolSchema,
    });

    const suggestCuts = tool(async ({ kind, minDurationSec, limit }) => {
      const document = getProject();
      if (kind !== 'filler' && kind !== 'pause') {
        throw new Error(`Unknown suggestion kind "${kind}". Use "filler" or "pause".`);
      }
      const suggestions = (kind === 'filler'
        ? buildFillerSuggestions(document)
        : buildPauseSuggestions(document, withDefault(minDurationSec, 0.6)))
        .slice(0, withDefault(limit, 6));
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
        reason: withDefault(reason, ''),
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
        reason: withDefault(reason, ''),
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
        transcriptSearch,
        suggestCuts,
        applyTimelineOperation,
        approveSuggestion,
        rejectSuggestion,
      ],
      systemPrompt: AXCUT_DEEP_AGENT_PROMPT,
    });
  }

  async invoke(projectId: string, sessionId: string, prompt: string, history: AgentConversationMessage[] = []) {
    this.getSession(projectId, sessionId);
    const hasCheckpoint = await this.restoreLatestCheckpointIfNeeded(sessionId);
    const invocationPrompt = buildAxcutInvocationPrompt(this.documents.readDocument(projectId), prompt);

    const agent = await this.create(projectId);
    const input = {
      messages: hasCheckpoint ? [new HumanMessage(invocationPrompt)] : buildAgentInputMessages(prompt, history, invocationPrompt),
    };
    const config = this.sessions.buildSessionConfig(sessionId);
    let result: unknown = null;
    let streamedResponse = '';
    const thinkingOperationId = randomUUID();
    let thinkingStartedAt = 0;

    if (typeof (agent as { streamEvents?: unknown }).streamEvents === 'function') {
      const stream = (agent as { streamEvents: (agentInput: unknown, config: Record<string, unknown>) => AsyncIterable<Record<string, unknown>> }).streamEvents(input, config);
      for await (const event of stream) {
        const eventType = typeof event.event === 'string' ? event.event : '';
        const name = typeof event.name === 'string' ? event.name : '';
        const runId = typeof event.run_id === 'string' ? event.run_id : randomUUID();
        const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};

        if (eventType === 'on_chat_model_start') {
          thinkingStartedAt = Date.now();
          this.events.emit(projectId, 'agent.operation', {
            sessionId,
            operation: {
              operationId: thinkingOperationId,
              label: 'Thinking',
              category: 'thinking',
              status: 'running',
              summary: name || 'Model is planning the next step.',
              startedAt: thinkingStartedAt,
            },
          });
          continue;
        }

        if (eventType === 'on_chat_model_stream') {
          const delta = extractStreamText(event);
          if (delta) {
            streamedResponse += delta;
            this.events.emit(projectId, 'agent.message.delta', { sessionId, delta });
          }
          continue;
        }

        if (eventType === 'on_chat_model_end' && thinkingStartedAt) {
          this.events.emit(projectId, 'agent.operation', {
            sessionId,
            operation: {
              operationId: thinkingOperationId,
              label: 'Thinking',
              category: 'thinking',
              status: 'done',
              summary: 'Model step completed.',
              startedAt: thinkingStartedAt,
              endedAt: Date.now(),
            },
          });
          continue;
        }

        if (eventType === 'on_tool_start') {
          this.events.emit(projectId, 'agent.operation', {
            sessionId,
            operation: {
              operationId: runId,
              label: humanizeToolName(name),
              category: name === 'shell' || name === 'bash' ? 'shell' : 'tool',
              status: 'running',
              body: truncate(safeStringify(data.input)),
              startedAt: Date.now(),
            },
          });
          continue;
        }

        if (eventType === 'on_tool_end') {
          this.events.emit(projectId, 'agent.operation', {
            sessionId,
            operation: {
              operationId: runId,
              label: humanizeToolName(name),
              category: name === 'shell' || name === 'bash' ? 'shell' : 'tool',
              status: 'done',
              summary: 'Tool completed.',
              body: truncate(safeStringify(data.output)),
              startedAt: Date.now(),
              endedAt: Date.now(),
            },
          });
          continue;
        }

        if (eventType === 'on_tool_error') {
          this.events.emit(projectId, 'agent.operation', {
            sessionId,
            operation: {
              operationId: runId,
              label: humanizeToolName(name),
              category: name === 'shell' || name === 'bash' ? 'shell' : 'tool',
              status: 'error',
              summary: 'Tool failed.',
              body: truncate(safeStringify(data.error)),
              startedAt: Date.now(),
              endedAt: Date.now(),
            },
          });
          continue;
        }

        if (eventType === 'on_chain_end') {
          result = extractResponseFromStreamEnd(event) ?? result;
        }
      }
    } else {
      result = await agent.invoke(input, config);
    }

    await this.sessions.saveCheckpoint(sessionId);
    const currentSession = this.sessions.get(sessionId);
    this.sessions.touch(sessionId, {
      title: currentSession?.title === 'New conversation'
        ? deriveSessionTitle(prompt)
        : currentSession?.title,
    });

    return {
      text: extractAgentResponseText(result) || streamedResponse.trim() || this.documents.readDocument(projectId).agent.lastReasoningSummary || 'Completed the editing turn.',
      state: result,
    };
  }

  private async restoreLatestCheckpointIfNeeded(sessionId: string): Promise<boolean> {
    const existing = await this.checkpointer.getTuple(this.sessions.buildSessionConfig(sessionId));
    if (existing) {
      return true;
    }

    const latest = this.sessions.listCheckpointsSync(sessionId)[0];
    if (!latest) {
      return false;
    }

    await this.sessions.restoreCheckpoint(sessionId, latest.id);
    return true;
  }

  private projectScope(projectId: string) {
    return { kind: 'axcut-project', key: projectId };
  }
}

const AXCUT_DEEP_AGENT_PROMPT = `You are Axcut, an expert agentic video editor.

Your job is to edit a local video project through structured tools rather than by rewriting large files directly.

Rules:
- The current project state, timeline, transcript segments, and suggestions are included in each user turn as Axcut project context.
- For direct editing requests, decide from that context and call an editing tool. Do not ask the user to restate information already present in the context.
- Prefer a single editing tool call when the context is sufficient, especially with Codex OAuth providers.
- Use transcript search only when the provided context is insufficient for locating a passage.
- When the user explicitly asks for options, suggestions, or proposals, use suggest_cuts and do not apply edits immediately.
- When the user gives a direct editing command with clear intent, apply the minimal structured operation needed.
- Use approve_suggestion or reject_suggestion when interacting with existing suggestions.
- Keep replies concise and explain what you changed or suggested.
- Never invent transcript content or timestamps.
- Do not ask unnecessary clarifying questions if the existing transcript and project state are sufficient.`;
