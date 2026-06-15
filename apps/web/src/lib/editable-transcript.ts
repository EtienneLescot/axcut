import type { AxcutClip, AxcutDocument, AxcutWord } from '@axcut/schema';

type TimelineWord = {
  index: number;
  word: AxcutWord;
  token: string;
};

export type EditableTranscriptUpdate = {
  intervals: Array<{ startSec: number; endSec: number }>;
  deletedWordIds: string[];
};

export function deriveEditableTranscriptUpdate(document: AxcutDocument, editedText: string): EditableTranscriptUpdate | null {
  const timelineWords = currentTimelineWords(document);
  if (timelineWords.length === 0) {
    return null;
  }

  const originalTokens = timelineWords.map((item) => item.token);
  const editedTokens = tokenizeEditedTranscriptText(editedText);
  const retainedIndexes = longestCommonSubsequenceIndexes(originalTokens, editedTokens);
  const deletedWords = timelineWords.filter((item) => !retainedIndexes.has(item.index));
  if (deletedWords.length === 0) {
    return null;
  }

  let intervals = document.timeline.clips.map((clip) => ({ startSec: clip.sourceStartSec, endSec: clip.sourceEndSec }));
  for (const range of deletedWordRanges(deletedWords)) {
    intervals = subtractInterval(intervals, range);
  }

  return {
    intervals: normalizeIntervals(intervals),
    deletedWordIds: deletedWords.map((item) => item.word.id),
  };
}

function currentTimelineWords(document: AxcutDocument): TimelineWord[] {
  const transcriptWords = document.transcript?.words ?? [];
  const words: TimelineWord[] = [];
  for (const clip of document.timeline.clips) {
    const clipWords = wordsForClip(transcriptWords, clip);
    for (const word of clipWords) {
      const token = normalizeToken(word.text);
      if (token) {
        words.push({ index: words.length, word, token });
      }
    }
  }
  return words;
}

function wordsForClip(words: AxcutWord[], clip: AxcutClip): AxcutWord[] {
  return words.filter((word) => word.endSec > clip.sourceStartSec && word.startSec < clip.sourceEndSec);
}

function tokenizeEditedTranscriptText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('# Clip '))
    .join(' ')
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function longestCommonSubsequenceIndexes(original: string[], edited: string[]): Set<number> {
  const rows = original.length + 1;
  const cols = edited.length + 1;
  const scores = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = original.length - 1; i >= 0; i -= 1) {
    for (let j = edited.length - 1; j >= 0; j -= 1) {
      scores[i][j] = original[i] === edited[j]
        ? scores[i + 1][j + 1] + 1
        : Math.max(scores[i + 1][j], scores[i][j + 1]);
    }
  }

  const retained = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < original.length && j < edited.length) {
    if (original[i] === edited[j]) {
      retained.add(i);
      i += 1;
      j += 1;
      continue;
    }
    if (scores[i + 1][j] >= scores[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return retained;
}

function deletedWordRanges(deletedWords: TimelineWord[]): Array<{ startSec: number; endSec: number }> {
  const ranges: Array<{ startSec: number; endSec: number }> = [];
  for (const [index, item] of deletedWords.entries()) {
    const previous = ranges.at(-1);
    const previousDeletedWord = deletedWords[index - 1];
    if (previous && previousDeletedWord && item.index === previousDeletedWord.index + 1) {
      previous.endSec = Math.max(previous.endSec, item.word.endSec);
      continue;
    }
    ranges.push({ startSec: item.word.startSec, endSec: item.word.endSec });
  }
  return ranges;
}

function subtractInterval(
  intervals: Array<{ startSec: number; endSec: number }>,
  cut: { startSec: number; endSec: number },
): Array<{ startSec: number; endSec: number }> {
  const output: Array<{ startSec: number; endSec: number }> = [];
  for (const interval of intervals) {
    if (cut.endSec <= interval.startSec || cut.startSec >= interval.endSec) {
      output.push(interval);
      continue;
    }
    if (cut.startSec > interval.startSec) {
      output.push({ startSec: interval.startSec, endSec: cut.startSec });
    }
    if (cut.endSec < interval.endSec) {
      output.push({ startSec: cut.endSec, endSec: interval.endSec });
    }
  }
  return output;
}

function normalizeIntervals(intervals: Array<{ startSec: number; endSec: number }>): Array<{ startSec: number; endSec: number }> {
  const sorted = intervals
    .filter((interval) => interval.endSec > interval.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const merged: Array<{ startSec: number; endSec: number }> = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.startSec > previous.endSec) {
      merged.push({ ...interval });
      continue;
    }
    previous.endSec = Math.max(previous.endSec, interval.endSec);
  }
  return merged;
}
