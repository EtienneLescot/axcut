import type {
  AxcutDocument,
  AxcutSuggestion,
  AxcutTimelineOperation,
  AxcutTranscriptSegment,
  AxcutWord,
} from '@axcut/schema';

import { createId } from './ids.js';
import { normalizeIntervals, subtractInterval, timelineIntervals } from './timeline.js';

const fillerLexicon = new Set([
  'uh',
  'um',
  'erm',
  'hmm',
  'hm',
  'ah',
  'eh',
  'er',
  'mm',
]);

const restorePromptPattern = /\b(restore|reset|start over|start-over|undo all|full timeline|full video|show everything|keep everything)\b/i;
const suggestionPromptPattern = /\b(suggest|proposal|propose|option|options|what can you cut|what should we cut)\b/i;
const fillerPromptPattern = /\b(filler|hesitation|stutter|stutters|disfluenc|um|uh)\b/i;
const pausePromptPattern = /\b(pause|pauses|silence|dead air|dead-air)\b/i;
const cutPromptPattern = /\b(cut|remove|trim|delete|drop)\b/i;
const searchPromptPattern = /\b(find|search|look for|where is|show me)\b/i;

export type TranscriptSearchHit = {
  segmentId: string;
  startWordId?: string;
  endWordId?: string;
  startSec: number;
  endSec: number;
  text: string;
  score: number;
};

export type RuntimeIntent =
  | { kind: 'restore'; summary: string; operation: AxcutTimelineOperation }
  | { kind: 'apply'; summary: string; intervals: Array<{ startSec: number; endSec: number }> }
  | { kind: 'suggest'; summary: string; suggestions: AxcutSuggestion[] }
  | { kind: 'message'; summary: string };

export function interpretPrompt(document: AxcutDocument, prompt: string): RuntimeIntent | null {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return { kind: 'message', summary: 'Describe the cut you want to make.' };
  }

  if (restorePromptPattern.test(normalizedPrompt)) {
    return {
      kind: 'restore',
      summary: 'Restored the full timeline from the source video.',
      operation: {
        type: 'restore_full_timeline',
        reason: 'Reset the timeline to the full source video.',
      },
    };
  }

  const transcript = document.transcript;
  if (!transcript) {
    return null;
  }

  const fillerSuggestions = fillerPromptPattern.test(normalizedPrompt)
    ? buildFillerSuggestions(document)
    : [];
  const pauseSuggestions = pausePromptPattern.test(normalizedPrompt)
    ? buildPauseSuggestions(document)
    : [];
  const combinedSuggestions = [...fillerSuggestions, ...pauseSuggestions].slice(0, 12);

  if (combinedSuggestions.length > 0) {
    if (suggestionPromptPattern.test(normalizedPrompt) || !cutPromptPattern.test(normalizedPrompt)) {
      return {
        kind: 'suggest',
        summary: `Prepared ${combinedSuggestions.length} structured cut suggestion${combinedSuggestions.length === 1 ? '' : 's'} from the current transcript.`,
        suggestions: combinedSuggestions,
      };
    }

    return {
      kind: 'apply',
      summary: summarizeAppliedSuggestions(combinedSuggestions),
      intervals: applySuggestionsToTimeline(document, combinedSuggestions),
    };
  }

  if (searchPromptPattern.test(normalizedPrompt)) {
    const hits = searchTranscript(document, normalizedPrompt, 5);
    if (hits.length > 0) {
      return {
        kind: 'message',
        summary: `Search hits: ${hits.map((hit) => `${formatRange(hit.startSec, hit.endSec)} ${hit.text}`).join(' | ')}`,
      };
    }
  }

  return null;
}

export function searchTranscript(document: AxcutDocument, query: string, limit = 8): TranscriptSearchHit[] {
  const transcript = document.transcript;
  if (!transcript) {
    return [];
  }
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }

  return transcript.segments
    .filter((segment) => segment.kind === 'speech')
    .map((segment) => scoreSegment(segment, transcript.words, tokens))
    .filter((hit): hit is TranscriptSearchHit => hit !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function buildFillerSuggestions(document: AxcutDocument): AxcutSuggestion[] {
  const transcript = document.transcript;
  if (!transcript) {
    return [];
  }
  const keptWordIds = new Set(document.timeline.clips.flatMap((clip) => clip.wordRefs));
  return transcript.words
    .filter((word) => keptWordIds.has(word.id))
    .filter((word) => fillerLexicon.has(normalizeToken(word.text)))
    .slice(0, 8)
    .map((word) => ({
      id: createId('sug'),
      status: 'pending' as const,
      category: 'cut_candidate' as const,
      suggestion: `Cut filler word "${word.text}"`,
      reason: 'Detected filler word in the current transcript.',
      startWordId: word.id,
      endWordId: word.id,
      startSec: word.startSec,
      endSec: word.endSec,
      proposedOperation: {
        type: 'drop_word_range' as const,
        startWordId: word.id,
        endWordId: word.id,
        reason: `Remove filler word "${word.text}".`,
      },
    }));
}

export function buildPauseSuggestions(document: AxcutDocument, minDurationSec = 0.6): AxcutSuggestion[] {
  const transcript = document.transcript;
  if (!transcript) {
    return [];
  }

  const currentIntervals = timelineIntervals(document);
  return transcript.segments
    .filter((segment) => segment.kind === 'silence')
    .filter((segment) => segment.endSec - segment.startSec >= minDurationSec)
    .filter((segment) => overlapsCurrentTimeline(currentIntervals, segment.startSec, segment.endSec))
    .slice(0, 6)
    .map((segment) => ({
      id: createId('sug'),
      status: 'pending' as const,
      category: 'cut_candidate' as const,
      suggestion: `Cut pause at ${formatRange(segment.startSec, segment.endSec)}`,
      reason: `Detected a ${Math.round((segment.endSec - segment.startSec) * 1000)} ms silence gap.`,
      startSec: segment.startSec,
      endSec: segment.endSec,
      proposedOperation: {
        type: 'drop_range' as const,
        startSec: segment.startSec,
        endSec: segment.endSec,
        reason: 'Remove a long silence gap.',
      },
    }));
}

export function applySuggestionsToTimeline(
  document: AxcutDocument,
  suggestions: AxcutSuggestion[],
): Array<{ startSec: number; endSec: number }> {
  const duration = document.assets.find((asset) => asset.id === document.project.primaryAssetId)?.durationSec
    ?? document.assets[0]?.durationSec
    ?? 0;
  let intervals = timelineIntervals(document);
  if (intervals.length === 0 && duration > 0) {
    intervals = [{ startSec: 0, endSec: duration }];
  }

  for (const suggestion of suggestions) {
    const operation = suggestion.proposedOperation;
    if (!operation) {
      continue;
    }
    if (operation.type === 'drop_range') {
      intervals = subtractInterval(intervals, { startSec: operation.startSec, endSec: operation.endSec });
      continue;
    }
    if (operation.type === 'drop_word_range') {
      const wordRange = resolveWordRange(document.transcript?.words ?? [], operation.startWordId, operation.endWordId);
      if (wordRange) {
        intervals = subtractInterval(intervals, wordRange);
      }
      continue;
    }
  }

  return normalizeIntervals(duration, intervals);
}

function summarizeAppliedSuggestions(suggestions: AxcutSuggestion[]): string {
  const fillerCount = suggestions.filter((item) => item.proposedOperation?.type === 'drop_word_range').length;
  const pauseCount = suggestions.filter((item) => item.proposedOperation?.type === 'drop_range').length;
  const parts = [];
  if (fillerCount > 0) {
    parts.push(`removed ${fillerCount} filler cue${fillerCount === 1 ? '' : 's'}`);
  }
  if (pauseCount > 0) {
    parts.push(`trimmed ${pauseCount} long pause${pauseCount === 1 ? '' : 's'}`);
  }
  return `Applied a structured transcript cut: ${parts.join(' and ')}.`;
}

function resolveWordRange(words: AxcutWord[], startWordId: string, endWordId: string): { startSec: number; endSec: number } | null {
  const start = words.find((word) => word.id === startWordId);
  const end = words.find((word) => word.id === endWordId);
  if (!start || !end) {
    return null;
  }
  return {
    startSec: Math.min(start.startSec, end.startSec),
    endSec: Math.max(start.endSec, end.endSec),
  };
}

function overlapsCurrentTimeline(
  intervals: Array<{ startSec: number; endSec: number }>,
  startSec: number,
  endSec: number,
): boolean {
  return intervals.some((interval) => interval.endSec > startSec && interval.startSec < endSec);
}

function scoreSegment(
  segment: AxcutTranscriptSegment,
  words: AxcutWord[],
  tokens: string[],
): TranscriptSearchHit | null {
  const haystack = normalizeText(segment.text);
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token.length;
    }
  }
  if (score === 0) {
    return null;
  }
  const segmentWords = words.filter((word) => word.segmentId === segment.id);
  return {
    segmentId: segment.id,
    startWordId: segmentWords[0]?.id,
    endWordId: segmentWords.at(-1)?.id,
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text,
    score,
  };
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeToken(value: string): string {
  return normalizeText(value).replace(/\s+/g, '');
}

function formatRange(startSec: number, endSec: number): string {
  return `${startSec.toFixed(1)}s-${endSec.toFixed(1)}s`;
}
