import type { AxcutClip, AxcutWord } from '@axcut/schema';

export type VirtualPosition = {
  clip: AxcutClip;
  clipIndex: number;
  virtualTimeSec: number;
  sourceTimeSec: number;
};

export type PlaybackPosition =
  | { kind: 'inside'; position: VirtualPosition }
  | { kind: 'next'; position: VirtualPosition }
  | { kind: 'ended'; position: VirtualPosition }
  | { kind: 'empty' };

export type SelectedWordRange = {
  startWordId: string;
  endWordId: string;
  words: AxcutWord[];
  text: string;
};

export function totalVirtualDuration(clips: AxcutClip[]): number {
  return clips.at(-1)?.timelineEndSec ?? 0;
}

export function clampVirtualTime(clips: AxcutClip[], value: number): number {
  if (clips.length === 0) {
    return 0;
  }
  return Math.max(0, Math.min(totalVirtualDuration(clips), value));
}

export function locateVirtualPosition(clips: AxcutClip[], virtualTimeSec: number): VirtualPosition | null {
  if (clips.length === 0) {
    return null;
  }
  const clamped = clampVirtualTime(clips, virtualTimeSec);
  let low = 0;
  let high = clips.length - 1;
  let resolvedIndex = clips.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const clip = clips[mid];
    const isLast = mid === clips.length - 1;
    if (clamped < clip.timelineStartSec) {
      high = mid - 1;
      continue;
    }
    if (clamped < clip.timelineEndSec || isLast) {
      resolvedIndex = mid;
      break;
    }
    low = mid + 1;
  }
  const clip = clips[resolvedIndex];
  const clipOffset = Math.max(0, Math.min(clip.sourceEndSec - clip.sourceStartSec, clamped - clip.timelineStartSec));
  return {
    clip,
    clipIndex: resolvedIndex,
    virtualTimeSec: clamped,
    sourceTimeSec: clip.sourceStartSec + clipOffset,
  };
}

export function locateSourcePosition(clips: AxcutClip[], sourceTimeSec: number, assetId?: string, epsilon = 0.05): VirtualPosition | null {
  const clipIndex = clips.findIndex((clip, index) => {
    if (assetId && clip.assetId !== assetId) {
      return false;
    }
    const lowerBound = clip.sourceStartSec - epsilon;
    const upperBound = index === clips.length - 1 ? clip.sourceEndSec + epsilon : clip.sourceEndSec - epsilon;
    return sourceTimeSec >= lowerBound && sourceTimeSec <= upperBound;
  });

  if (clipIndex < 0) {
    return null;
  }

  const clip = clips[clipIndex];
  const sourceOffset = Math.max(0, Math.min(clip.sourceEndSec - clip.sourceStartSec, sourceTimeSec - clip.sourceStartSec));
  return {
    clip,
    clipIndex,
    virtualTimeSec: clip.timelineStartSec + sourceOffset,
    sourceTimeSec,
  };
}

export function resolvePlaybackPosition(clips: AxcutClip[], sourceTimeSec: number, assetId?: string, epsilon = 0.05): PlaybackPosition {
  const position = locateSourcePosition(clips, sourceTimeSec, assetId, epsilon);
  if (position) {
    return { kind: 'inside', position };
  }

  const nextClip = clips.find((clip) => (!assetId || clip.assetId === assetId) && clip.sourceStartSec > sourceTimeSec);
  if (nextClip) {
    const nextPosition = locateVirtualPosition(clips, nextClip.timelineStartSec);
    return nextPosition ? { kind: 'next', position: nextPosition } : { kind: 'empty' };
  }

  const endPosition = locateVirtualPosition(clips, totalVirtualDuration(clips));
  return endPosition ? { kind: 'ended', position: endPosition } : { kind: 'empty' };
}

export function keptWordIdSet(clips: AxcutClip[]): Set<string> {
  return new Set(clips.flatMap((clip) => clip.wordRefs));
}

export function selectWordRange(words: AxcutWord[], anchorWordId: string | null, focusWordId: string | null): SelectedWordRange | null {
  if (!anchorWordId || !focusWordId) {
    return null;
  }
  const startIndex = words.findIndex((word) => word.id === anchorWordId);
  const endIndex = words.findIndex((word) => word.id === focusWordId);
  if (startIndex < 0 || endIndex < 0) {
    return null;
  }
  const [from, to] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
  const selectedWords = words.slice(from, to + 1);
  return {
    startWordId: selectedWords[0].id,
    endWordId: selectedWords[selectedWords.length - 1].id,
    words: selectedWords,
    text: selectedWords.map((word) => word.text).join(' '),
  };
}

export function formatSeconds(value: number): string {
  const safe = Math.max(0, value);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
  }
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}
