import type {
  AxcutDocument,
  AxcutSuggestion,
  AxcutTranscriptSegment,
  AxcutWord,
} from '@axcut/schema';

import { createId } from './ids.js';
import { normalizeIntervals } from './timeline.js';

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
  assetId: string;
  segmentId: string;
  startWordId?: string;
  endWordId?: string;
  startSec: number;
  endSec: number;
  text: string;
  score: number;
  words: Array<{
    id: string;
    startSec: number;
    endSec: number;
    text: string;
  }>;
  matches: Array<{
    assetId: string;
    startWordId: string;
    endWordId: string;
    startSec: number;
    endSec: number;
    text: string;
  }>;
};

export function searchTranscript(document: AxcutDocument, query: string, limit = 8): TranscriptSearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }

  const intervalsByAsset = buildTimelineIntervalsByAsset(document);
  return documentTranscripts(document)
    .flatMap((transcript) => {
      const currentIntervals = intervalsByAsset.get(transcript.assetId) ?? [];
      if (currentIntervals.length === 0) {
        return [];
      }
      return transcript.segments
        .filter((segment) => segment.kind === 'speech')
        .filter((segment) => overlapsCurrentTimeline(currentIntervals, segment.startSec, segment.endSec))
        .map((segment) => scoreSegment(transcript.assetId, segment, transcript.words, tokens));
    })
    .filter((hit): hit is TranscriptSearchHit => hit !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function buildFillerSuggestions(document: AxcutDocument): AxcutSuggestion[] {
  const keptWordKeys = new Set(document.timeline.clips.flatMap((clip) => clip.wordRefs.map((wordId) => wordKey(clip.assetId, wordId))));
  return documentTranscripts(document)
    .flatMap((transcript) => transcript.words
      .filter((word) => keptWordKeys.has(wordKey(word.assetId ?? transcript.assetId, word.id)))
      .filter((word) => fillerLexicon.has(normalizeToken(word.text)))
      .map((word) => ({ transcript, word })))
    .slice(0, 8)
    .map(({ transcript, word }) => {
      const assetId = word.assetId ?? transcript.assetId;
      return {
        id: createId('sug'),
        status: 'pending' as const,
        category: 'cut_candidate' as const,
        suggestion: `Skip filler word "${word.text}"`,
        reason: 'Detected filler word in a clip that is currently on the timeline.',
        startWordId: word.id,
        endWordId: word.id,
        startSec: word.startSec,
        endSec: word.endSec,
        proposedOperation: {
          type: 'add_skip_range' as const,
          assetId,
          startSec: word.startSec,
          endSec: word.endSec,
          reason: `Skip filler word "${word.text}".`,
        },
      };
    });
}

export function buildPauseSuggestions(document: AxcutDocument, minDurationSec = 0.6): AxcutSuggestion[] {
  const intervalsByAsset = buildTimelineIntervalsByAsset(document);
  return documentTranscripts(document)
    .flatMap((transcript) => {
      const currentIntervals = intervalsByAsset.get(transcript.assetId) ?? [];
      if (currentIntervals.length === 0) {
        return [];
      }
      return transcript.segments
        .filter((segment) => segment.kind === 'silence')
        .filter((segment) => segment.endSec - segment.startSec >= minDurationSec)
        .filter((segment) => overlapsCurrentTimeline(currentIntervals, segment.startSec, segment.endSec))
        .map((segment) => ({ transcript, segment }));
    })
    .slice(0, 6)
    .map(({ transcript, segment }) => {
      const assetId = segment.assetId ?? transcript.assetId;
      return {
        id: createId('sug'),
        status: 'pending' as const,
        category: 'cut_candidate' as const,
        suggestion: `Skip pause at ${formatRange(segment.startSec, segment.endSec)}`,
        reason: `Detected a ${Math.round((segment.endSec - segment.startSec) * 1000)} ms silence gap.`,
        startSec: segment.startSec,
        endSec: segment.endSec,
        proposedOperation: {
          type: 'add_skip_range' as const,
          assetId,
          startSec: segment.startSec,
          endSec: segment.endSec,
          reason: 'Skip a long silence gap.',
        },
      };
    });
}

function documentTranscripts(document: AxcutDocument) {
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

function wordKey(assetId: string, wordId: string): string {
  return `${assetId}:${wordId}`;
}

function overlapsCurrentTimeline(
  intervals: Array<{ startSec: number; endSec: number }>,
  startSec: number,
  endSec: number,
): boolean {
  return intervals.some((interval) => interval.endSec > startSec && interval.startSec < endSec);
}

function scoreSegment(
  assetId: string,
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
  const matches = findPhraseMatches(assetId, segmentWords, tokens);
  return {
    assetId,
    segmentId: segment.id,
    startWordId: segmentWords[0]?.id,
    endWordId: segmentWords.at(-1)?.id,
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text,
    score,
    words: segmentWords.map((word) => ({
      id: word.id,
      startSec: word.startSec,
      endSec: word.endSec,
      text: word.text,
    })),
    matches,
  };
}

function findPhraseMatches(assetId: string, words: AxcutWord[], tokens: string[]): TranscriptSearchHit['matches'] {
  if (tokens.length === 0 || words.length === 0) {
    return [];
  }

  const normalizedWords = words.map((word) => normalizeToken(word.text));
  const matches: TranscriptSearchHit['matches'] = [];
  for (let index = 0; index <= normalizedWords.length - tokens.length; index += 1) {
    const matched = tokens.every((token, offset) => normalizedWords[index + offset] === token);
    if (!matched) {
      continue;
    }
    const span = words.slice(index, index + tokens.length);
    const first = span[0];
    const last = span.at(-1);
    if (!first || !last) {
      continue;
    }
    matches.push({
      assetId,
      startWordId: first.id,
      endWordId: last.id,
      startSec: first.startSec,
      endSec: last.endSec,
      text: span.map((word) => word.text).join(' '),
    });
  }
  return matches;
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
