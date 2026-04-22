import { z } from 'zod';

export const axcutSchemaVersion = 2;

export const isoDateSchema = z.string().datetime({ offset: true });

export const wordSchema = z.object({
  id: z.string().min(1),
  segmentId: z.string().min(1),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  text: z.string(),
});

export const transcriptSegmentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['speech', 'silence']),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  text: z.string(),
  wordIds: z.array(z.string().min(1)).default([]),
});

export const transcriptSchema = z.object({
  assetId: z.string().min(1),
  language: z.string().min(1),
  sourceDslPath: z.string().optional(),
  sourceJsonPath: z.string().optional(),
  segments: z.array(transcriptSegmentSchema).default([]),
  words: z.array(wordSchema).default([]),
});

export const assetVideoSchema = z.object({
  codec: z.string().default('unknown'),
  width: z.number().int().nonnegative().default(0),
  height: z.number().int().nonnegative().default(0),
  fps: z.number().nonnegative().default(0),
});

export const assetAudioSchema = z.object({
  codec: z.string().default('unknown'),
  sampleRate: z.number().int().nonnegative().default(0),
  channels: z.number().int().nonnegative().default(0),
});

export const assetSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('video'),
  label: z.string().min(1),
  originalPath: z.string().min(1),
  proxyPath: z.string().optional(),
  waveformPath: z.string().optional(),
  durationSec: z.number().nonnegative().optional(),
  video: assetVideoSchema.optional(),
  audio: assetAudioSchema.optional(),
});

export const clipSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  sourceStartSec: z.number().nonnegative(),
  sourceEndSec: z.number().nonnegative(),
  timelineStartSec: z.number().nonnegative(),
  timelineEndSec: z.number().nonnegative(),
  wordRefs: z.array(z.string().min(1)).default([]),
  origin: z.enum(['system', 'agent', 'user']),
  reason: z.string().default(''),
});

export const gapSchema = z.object({
  id: z.string().min(1),
  timelineStartSec: z.number().nonnegative(),
  timelineEndSec: z.number().nonnegative(),
  reason: z.string().default(''),
});

export const rangeSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  reason: z.string().default(''),
});

export const timelineSchema = z.object({
  clips: z.array(clipSchema).default([]),
  gaps: z.array(gapSchema).default([]),
  muteRanges: z.array(rangeSchema).default([]),
  speedRanges: z.array(rangeSchema).default([]),
  captionRanges: z.array(rangeSchema).default([]),
});

export const pendingQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  reason: z.string().default(''),
  startWordId: z.string().optional(),
  endWordId: z.string().optional(),
});

export const previewSchema = z.object({
  strategy: z.enum(['seek', 'mse-proxy']).default('seek'),
  revision: z.number().int().nonnegative().default(0),
});

export const exportStateSchema = z.object({
  preset: z.enum(['preview-low', 'final-balanced', 'final-high']).default('final-balanced'),
  lastJobId: z.string().nullable().default(null),
});

export const timelineOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('replace_timeline'),
    reason: z.string().default(''),
    intervals: z.array(z.object({ startSec: z.number().nonnegative(), endSec: z.number().nonnegative() })).default([]),
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
]);

export const suggestionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  category: z.enum(['cut_candidate', 'style', 'delivery', 'topic_focus', 'clarification']).default('cut_candidate'),
  suggestion: z.string().min(1),
  reason: z.string().default(''),
  startWordId: z.string().optional(),
  endWordId: z.string().optional(),
  startSec: z.number().nonnegative().optional(),
  endSec: z.number().nonnegative().optional(),
  proposedOperation: timelineOperationSchema.optional(),
});

export const agentStateSchema = z.object({
  baseIntent: z.string().optional(),
  pendingQuestions: z.array(pendingQuestionSchema).default([]),
  suggestions: z.array(suggestionSchema).default([]),
  lastAppliedOperations: z.array(z.string()).default([]),
  lastReasoningSummary: z.string().optional(),
});

export const operationSchema = z.discriminatedUnion('type', [
  timelineOperationSchema,
  z.object({
    type: z.literal('approve_suggestion'),
    reason: z.string().default(''),
    suggestionId: z.string().min(1),
  }),
  z.object({
    type: z.literal('reject_suggestion'),
    reason: z.string().default(''),
    suggestionId: z.string().min(1),
  }),
]);

export const revisionSchema = z.object({
  id: z.string().min(1),
  createdAt: isoDateSchema,
  author: z.enum(['system', 'agent', 'user']),
  summary: z.string().min(1),
  operations: z.array(operationSchema).default([]),
});

export const documentSchema = z.object({
  schemaVersion: z.literal(axcutSchemaVersion),
  project: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
    primaryAssetId: z.string().optional(),
  }),
  assets: z.array(assetSchema).default([]),
  transcript: transcriptSchema.nullable().default(null),
  timeline: timelineSchema.default({ clips: [], gaps: [], muteRanges: [], speedRanges: [], captionRanges: [] }),
  agent: agentStateSchema.default({ pendingQuestions: [], suggestions: [], lastAppliedOperations: [] }),
  preview: previewSchema.default({ strategy: 'seek', revision: 0 }),
  export: exportStateSchema.default({ preset: 'final-balanced', lastJobId: null }),
  history: z.object({
    revisions: z.array(revisionSchema).default([]),
  }).default({ revisions: [] }),
});

export const createProjectInputSchema = z.object({
  title: z.string().trim().min(1).default('Untitled Project'),
});

export const addAssetInputSchema = z.object({
  path: z.string().trim().min(1),
  label: z.string().trim().optional(),
  autoTranscribe: z.boolean().default(true),
});

export const chatInputSchema = z.object({
  message: z.string().trim().min(1),
});

export const exportInputSchema = z.object({
  preset: exportStateSchema.shape.preset.default('final-balanced'),
});

export const applyOperationInputSchema = z.object({
  operation: operationSchema,
});

export type AxcutWord = z.infer<typeof wordSchema>;
export type AxcutTranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type AxcutTranscript = z.infer<typeof transcriptSchema>;
export type AxcutAsset = z.infer<typeof assetSchema>;
export type AxcutClip = z.infer<typeof clipSchema>;
export type AxcutTimeline = z.infer<typeof timelineSchema>;
export type AxcutSuggestion = z.infer<typeof suggestionSchema>;
export type AxcutAgentState = z.infer<typeof agentStateSchema>;
export type AxcutTimelineOperation = z.infer<typeof timelineOperationSchema>;
export type AxcutOperation = z.infer<typeof operationSchema>;
export type AxcutRevision = z.infer<typeof revisionSchema>;
export type AxcutDocument = z.infer<typeof documentSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type AddAssetInput = z.infer<typeof addAssetInputSchema>;
export type ChatInput = z.infer<typeof chatInputSchema>;
export type ExportInput = z.infer<typeof exportInputSchema>;
export type ApplyOperationInput = z.infer<typeof applyOperationInputSchema>;

export function createEmptyDocument(input: CreateProjectInput & { projectId: string; createdAt?: string }): AxcutDocument {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return documentSchema.parse({
    schemaVersion: axcutSchemaVersion,
    project: {
      id: input.projectId,
      title: input.title,
      createdAt,
      updatedAt: createdAt,
    },
    assets: [],
    transcript: null,
    timeline: { clips: [], gaps: [], muteRanges: [], speedRanges: [], captionRanges: [] },
    agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
    preview: { strategy: 'seek', revision: 0 },
    export: { preset: 'final-balanced', lastJobId: null },
    history: { revisions: [] },
  });
}

export function ensureDocument(value: unknown): AxcutDocument {
  return documentSchema.parse(value);
}
