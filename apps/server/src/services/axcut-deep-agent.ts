import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createDeepAgent } from 'deepagents';
import { AIMessage, HumanMessage, SystemMessage, tool } from 'langchain';
import { z } from 'zod';

import type { AxcutDocument, AxcutOperation, AxcutSuggestion } from '@axcut/schema';

import { buildFillerSuggestions, buildPauseSuggestions, searchTranscript } from '../lib/structured-agent.js';
import { normalizeIntervals } from '../lib/timeline.js';
import { agentSessionsRoot } from '../lib/paths.js';
import { createAxcutChatModel } from '../llm/create-chat-model.js';
import {
  AgentSessionService,
  deriveSessionTitle,
  PersistentFileCheckpointSaver,
  type DeepAgentSessionRecord,
  type RestoreCheckpointResult,
  type SaveCheckpointOptions,
  type SessionCheckpointMetadata,
  type SessionCheckpointPayload,
} from './agent-session-service.js';
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
  type: z.string().min(1).describe('Operation type: "add_skip_range", "update_skip_range", "remove_skip_range", "drop_word_range", "update_clip_range", "duplicate_clip", "move_clip", "restore_full_timeline", "replace_timeline", or "drop_range". Use skip operations for cleanup; replace_timeline/drop_range are structural clip edits.'),
  reason: nullableString,
  intervalsJson: nullableString.describe('For replace_timeline only: JSON array like [{"startSec":0,"endSec":12.5}] or [[0,12.5]]. Avoid for normal silence/filler cleanup.'),
  assetId: nullableString.describe('For add_skip_range or structural drop_range on a specific asset. Required for add_skip_range.'),
  skipId: nullableString.describe('For update_skip_range or remove_skip_range only.'),
  clipId: nullableString.describe('For update_clip_range, duplicate_clip, or move_clip only.'),
  insertIndex: z.number().int().nonnegative().nullable().default(null).describe('For move_clip only: final clip order index after removing the moved clip.'),
  startSec: z.number().nonnegative().nullable().default(null).describe('For drop_range, add_skip_range, or update_skip_range.'),
  endSec: z.number().nonnegative().nullable().default(null).describe('For drop_range, add_skip_range, or update_skip_range.'),
  sourceStartSec: z.number().nonnegative().nullable().default(null).describe('For update_clip_range only.'),
  sourceEndSec: z.number().nonnegative().nullable().default(null).describe('For update_clip_range only.'),
  startWordId: nullableString.describe('For drop_word_range only.'),
  endWordId: nullableString.describe('For drop_word_range only.'),
}).strict();

const suggestionDecisionToolSchema = z.object({
  suggestionId: z.string().min(1),
  reason: nullableString,
}).strict();

const MAX_CONTEXT_SEGMENTS = 240;
const MAX_CONTEXT_WORDS = 800;
const MAX_SKIP_HINTS = 80;

type TimelineOperationToolInput = z.infer<typeof timelineOperationToolSchema>;
type AxcutTranscript = NonNullable<AxcutDocument['transcript']>;

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
        assetId: input.assetId ?? undefined,
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
    case 'add_skip_range':
      if (!input.assetId || withDefault(input.endSec, 0) <= withDefault(input.startSec, 0)) {
        throw new Error('add_skip_range requires assetId and endSec to be greater than startSec.');
      }
      return {
        type: 'add_skip_range',
        reason,
        assetId: input.assetId,
        startSec: withDefault(input.startSec, 0),
        endSec: withDefault(input.endSec, 0),
      };
    case 'update_skip_range':
      if (!input.skipId || withDefault(input.endSec, 0) <= withDefault(input.startSec, 0)) {
        throw new Error('update_skip_range requires skipId and endSec to be greater than startSec.');
      }
      return {
        type: 'update_skip_range',
        reason,
        skipId: input.skipId,
        startSec: withDefault(input.startSec, 0),
        endSec: withDefault(input.endSec, 0),
      };
    case 'remove_skip_range':
      if (!input.skipId) {
        throw new Error('remove_skip_range requires skipId.');
      }
      return {
        type: 'remove_skip_range',
        reason,
        skipId: input.skipId,
      };
    case 'update_clip_range':
      if (!input.clipId || withDefault(input.sourceEndSec, 0) <= withDefault(input.sourceStartSec, 0)) {
        throw new Error('update_clip_range requires clipId and sourceEndSec to be greater than sourceStartSec.');
      }
      return {
        type: 'update_clip_range',
        reason,
        clipId: input.clipId,
        sourceStartSec: withDefault(input.sourceStartSec, 0),
        sourceEndSec: withDefault(input.sourceEndSec, 0),
      };
    case 'duplicate_clip':
      if (!input.clipId) {
        throw new Error('duplicate_clip requires clipId.');
      }
      return {
        type: 'duplicate_clip',
        reason,
        clipId: input.clipId,
      };
    case 'move_clip':
      if (!input.clipId || input.insertIndex === null) {
        throw new Error('move_clip requires clipId and insertIndex.');
      }
      return {
        type: 'move_clip',
        reason,
        clipId: input.clipId,
        insertIndex: input.insertIndex,
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
  const timelineByAsset = buildTimelineIntervalsByAsset(document);
  const transcripts = buildTimelineTranscriptContexts(document, timelineByAsset);
  const skipCandidates = buildSkipCandidates(document, timelineByAsset);
  const firstSpeechRange = findFirstCurrentSpeechRange(document, timelineByAsset);
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
      assetId: clip.assetId,
      sourceStartSec: clip.sourceStartSec,
      sourceEndSec: clip.sourceEndSec,
      timelineStartSec: clip.timelineStartSec,
      timelineEndSec: clip.timelineEndSec,
      reason: clip.reason,
    })),
    transcripts,
    suggestions: document.agent.suggestions,
    operationHints: {
      silenceSkipCandidates: skipCandidates.silences,
      fillerSkipCandidates: skipCandidates.fillers,
      firstCurrentSpeechRange: firstSpeechRange,
    },
  };

  return [
    'Axcut project context for this turn:',
    JSON.stringify(context),
    '',
    'Operation guidance:',
    '- The LLM must decide whether an edit is appropriate. Do not edit unless the user requested it.',
    '- For cleanup requests such as removing blanks, silences, hesitations, filler words, or verbal habits, create non-destructive skips. Use apply_timeline_operation with type "add_skip_range" and the assetId/source timestamps from operationHints or transcripts.',
    '- Do not use replace_timeline or drop_range for normal cleanup. Those are structural clip operations and can split/rebuild clips; reserve them for explicit structural timeline requests.',
    '- For removing the first phrase/first spoken segment, prefer add_skip_range with operationHints.firstCurrentSpeechRange.assetId/startSec/endSec.',
    '- For skipping exact words, phrases, hesitations, or filler tokens, prefer add_skip_range with assetId/startSec/endSec. Use drop_word_range only when the word ids are unambiguous for the current asset.',
    '- For timeline-level skip edits, use add_skip_range, update_skip_range, or remove_skip_range. A skip excludes playback/export but does not alter clip source bounds.',
    '- For structural clip editing, use update_clip_range to change clip source bounds, duplicate_clip to copy a clip instance, or move_clip to reorder clips. Do not use skip operations for clip trimming/reordering.',
    '- search_transcript returns source transcript segments plus word ids/timestamps and exact phrase matches when available.',
    '- The transcript contexts include only assets that are currently used by timeline clips. Uploaded-but-not-mounted assets must not affect cleanup edits or the visible transcript.',
    '- If the requested edit is not covered by operationHints, derive the minimal skip operation from the source timeline/transcript context or use search_transcript first.',
    '- Prefer the fewest tool calls that accurately express the requested edit; cleanup can require multiple add_skip_range calls.',
    '',
    'User request:',
    prompt,
  ].join('\n');
}

function buildTimelineTranscriptContexts(
  document: AxcutDocument,
  timelineByAsset: Map<string, Array<{ startSec: number; endSec: number }>>,
) {
  return documentTranscripts(document)
    .filter((transcript) => (timelineByAsset.get(transcript.assetId) ?? []).length > 0)
    .map((transcript) => {
      const intervals = timelineByAsset.get(transcript.assetId) ?? [];
      const segments = transcript.segments
        .filter((segment) => overlapsIntervals(intervals, segment.startSec, segment.endSec));
      const words = transcript.words
        .filter((word) => overlapsIntervals(intervals, word.startSec, word.endSec));
      return {
        assetId: transcript.assetId,
        language: transcript.language,
        segmentCount: transcript.segments.length,
        wordCount: transcript.words.length,
        includedTimelineIntervals: intervals,
        segmentsTruncated: segments.length > MAX_CONTEXT_SEGMENTS,
        wordsTruncated: words.length > MAX_CONTEXT_WORDS,
        segments: segments.slice(0, MAX_CONTEXT_SEGMENTS).map((segment) => ({
          id: segment.id,
          assetId: segment.assetId ?? transcript.assetId,
          kind: segment.kind,
          startSec: segment.startSec,
          endSec: segment.endSec,
          text: segment.text,
          wordIds: segment.wordIds,
        })),
        words: words.slice(0, MAX_CONTEXT_WORDS).map((word) => ({
          id: word.id,
          assetId: word.assetId ?? transcript.assetId,
          segmentId: word.segmentId,
          startSec: word.startSec,
          endSec: word.endSec,
          text: word.text,
        })),
      };
    });
}

function buildSkipCandidates(
  document: AxcutDocument,
  timelineByAsset: Map<string, Array<{ startSec: number; endSec: number }>>,
) {
  const silences: Array<{ assetId: string; startSec: number; endSec: number; durationSec: number; reason: string }> = [];
  const fillers: Array<{ assetId: string; wordId: string; startSec: number; endSec: number; text: string; reason: string }> = [];
  const fillerLexicon = new Set(['uh', 'um', 'erm', 'hmm', 'hm', 'ah', 'eh', 'er', 'mm', 'euh', 'heu']);

  for (const transcript of documentTranscripts(document)) {
    const intervals = timelineByAsset.get(transcript.assetId) ?? [];
    if (intervals.length === 0) {
      continue;
    }
    for (const segment of transcript.segments) {
      const durationSec = segment.endSec - segment.startSec;
      if (segment.kind !== 'silence' || durationSec < 0.35 || !overlapsIntervals(intervals, segment.startSec, segment.endSec)) {
        continue;
      }
      silences.push({
        assetId: segment.assetId ?? transcript.assetId,
        startSec: segment.startSec,
        endSec: segment.endSec,
        durationSec,
        reason: 'silence',
      });
    }
    for (const word of transcript.words) {
      if (!overlapsIntervals(intervals, word.startSec, word.endSec) || !fillerLexicon.has(normalizePromptToken(word.text))) {
        continue;
      }
      fillers.push({
        assetId: word.assetId ?? transcript.assetId,
        wordId: word.id,
        startSec: word.startSec,
        endSec: word.endSec,
        text: word.text,
        reason: 'filler_or_hesitation',
      });
    }
  }

  return {
    silences: silences.slice(0, MAX_SKIP_HINTS),
    fillers: fillers.slice(0, MAX_SKIP_HINTS),
  };
}

function findFirstCurrentSpeechRange(
  document: AxcutDocument,
  timelineByAsset: Map<string, Array<{ startSec: number; endSec: number }>>,
): { assetId: string; startSec: number; endSec: number } | null {
  const candidates: Array<{ assetId: string; startSec: number; endSec: number }> = [];
  for (const transcript of documentTranscripts(document)) {
    const intervals = timelineByAsset.get(transcript.assetId) ?? [];
    if (intervals.length === 0) {
      continue;
    }
    for (const segment of transcript.segments.filter((item) => item.kind === 'speech')) {
      for (const interval of intervals) {
        const startSec = Math.max(segment.startSec, interval.startSec);
        const endSec = Math.min(segment.endSec, interval.endSec);
        if (endSec > startSec) {
          candidates.push({ assetId: segment.assetId ?? transcript.assetId, startSec, endSec });
        }
      }
    }
  }
  return candidates.sort((left, right) => left.startSec - right.startSec)[0] ?? null;
}

function documentTranscripts(document: AxcutDocument): AxcutTranscript[] {
  return document.transcripts.length > 0
    ? document.transcripts
    : document.transcript ? [document.transcript] : [];
}

function buildTimelineIntervalsByAsset(document: AxcutDocument): Map<string, Array<{ startSec: number; endSec: number }>> {
  const rawIntervals = new Map<string, Array<{ startSec: number; endSec: number }>>();
  for (const clip of document.timeline.clips) {
    const intervals = rawIntervals.get(clip.assetId) ?? [];
    intervals.push({ startSec: clip.sourceStartSec, endSec: clip.sourceEndSec });
    rawIntervals.set(clip.assetId, intervals);
  }

  return new Map([...rawIntervals].map(([assetId, intervals]) => [
    assetId,
    normalizeIntervals(assetDuration(document, assetId), intervals),
  ]));
}

function assetDuration(document: AxcutDocument, assetId: string): number {
  return document.assets.find((asset) => asset.id === assetId)?.durationSec ?? 0;
}

function overlapsIntervals(intervals: Array<{ startSec: number; endSec: number }>, startSec: number, endSec: number): boolean {
  return intervals.some((interval) => interval.endSec > startSec && interval.startSec < endSec);
}

function normalizePromptToken(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class AxcutDeepAgentService {
  private readonly checkpointer = new PersistentFileCheckpointSaver(path.join(agentSessionsRoot, 'langgraph-checkpoints'));
  private readonly sessions = new AgentSessionService(agentSessionsRoot);

  constructor(
    private readonly documents: DocumentService,
    private readonly events: EventBus,
    private readonly llmConfig: LlmConfigService,
  ) {
    this.sessions.setCheckpointer(this.checkpointer);
  }

  getOrCreateSession(projectId: string): DeepAgentSessionRecord {
    const scope = this.projectScope(projectId);
    return this.sessions.getActiveForScope(scope)
      ?? this.sessions.ensure(projectId, { title: 'New conversation', scope });
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

  listCheckpoints(projectId: string, sessionId: string): SessionCheckpointMetadata[] {
    this.getSession(projectId, sessionId);
    return this.sessions.listCheckpointsSync(sessionId);
  }

  async saveCheckpoint(
    projectId: string,
    sessionId: string,
    payload: SessionCheckpointPayload,
    options: Omit<SaveCheckpointOptions, 'payload'> = {},
  ): Promise<SessionCheckpointMetadata> {
    this.getSession(projectId, sessionId);
    return this.sessions.saveCheckpoint(sessionId, { ...options, payload });
  }

  async restoreCheckpoint(projectId: string, sessionId: string, checkpointId: string): Promise<RestoreCheckpointResult> {
    this.getSession(projectId, sessionId);
    return this.sessions.restoreCheckpoint(sessionId, checkpointId);
  }

  async deleteCheckpoint(projectId: string, sessionId: string, checkpointId: string): Promise<void> {
    this.getSession(projectId, sessionId);
    await this.sessions.deleteCheckpoint(sessionId, checkpointId);
  }

  async resetRuntimeThread(projectId: string, sessionId: string): Promise<void> {
    this.getSession(projectId, sessionId);
    await this.sessions.resetRuntimeThread(sessionId);
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
      description: 'Apply a structured Axcut DSL mutation. Use add_skip_range/update_skip_range/remove_skip_range for non-destructive cleanup. Use clip operations only when the user asks for structural timeline editing.',
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

    return createDeepAgent({
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
    this.sessions.clearRestoredRuntimeCheckpoint(sessionId);
    let result: unknown = null;
    let streamedResponse = '';
    let thinkingOperationId = '';

    if (typeof (agent as { streamEvents?: unknown }).streamEvents === 'function') {
      const stream = (agent as { streamEvents: (agentInput: unknown, config: unknown) => AsyncIterable<Record<string, unknown>> }).streamEvents(input, config);
      for await (const event of stream) {
        const eventType = typeof event.event === 'string' ? event.event : '';
        const name = typeof event.name === 'string' ? event.name : '';
        const runId = typeof event.run_id === 'string' ? event.run_id : randomUUID();
        const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};

        if (eventType === 'on_chat_model_start') {
          thinkingOperationId = `thinking:${runId}`;
          this.events.emit(projectId, 'agent.operation', {
            sessionId,
            operation: {
              operationId: thinkingOperationId,
              label: 'Thinking',
              category: 'thinking',
              status: 'running',
              summary: name || 'Model is planning the next step.',
              startedAt: Date.now(),
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

        if (eventType === 'on_chat_model_end' && thinkingOperationId) {
          this.events.emit(projectId, 'agent.operation', {
            sessionId,
            operation: {
              operationId: thinkingOperationId,
              label: 'Thinking',
              category: 'thinking',
              status: 'done',
              startedAt: Date.now(),
              endedAt: Date.now(),
            },
          });
          thinkingOperationId = '';
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
    if (!latest?.runtimeCheckpointId) {
      return false;
    }

    const restored = await this.sessions.restoreCheckpoint(sessionId, latest.id);
    return restored.langGraphRestored;
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
- Prefer the fewest editing tool calls that accurately express the edit; multiple skip ranges are appropriate for cleanup.
- Use transcript search only when the provided context is insufficient for locating a passage.
- When the user explicitly asks for options, suggestions, or proposals, use suggest_cuts and do not apply edits immediately.
- When the user gives a direct editing command with clear intent, apply the minimal structured operation needed.
- Cleanup edits such as removing silences, blanks, hesitations, filler words, or verbal habits must use non-destructive skip operations unless the user explicitly asks to split, trim, rebuild, or reorder clips.
- Structural clip operations are for montage structure only: clip source bounds, duplication, insertion, and ordering.
- Use approve_suggestion or reject_suggestion when interacting with existing suggestions.
- Keep replies concise and explain what you changed or suggested.
- Never invent transcript content or timestamps.
- Do not ask unnecessary clarifying questions if the existing transcript and project state are sufficient.`;
