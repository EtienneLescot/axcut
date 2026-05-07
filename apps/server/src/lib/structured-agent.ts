import type {
  AxcutDocument,
  AxcutSuggestion,
  AxcutTranscriptSegment,
  AxcutWord,
} from '@axcut/schema';

import { createId } from './ids.js';
import { timelineIntervals } from './timeline.js';

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

const fillerPromptPattern = /\b(filler|hesitation|stutter|stutters|disfluenc|um|uh)\b/i;

export type TranscriptSearchHit = {
  segmentId: string;
  startWordId?: string;
  endWordId?: string;
  startSec: number;
  endSec: number;
  text: string;
  score: number;
};

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
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeToken(value: string): string {
  return normalizeText(value).replace(/\s+/g, '');
}

function formatRange(startSec: number, endSec: number): string {
  return `${startSec.toFixed(1)}s-${endSec.toFixed(1)}s`;
}
