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
  const clipIndex = clips.findIndex((clip, index) => {
    const isLast = index === clips.length - 1;
    return clamped >= clip.timelineStartSec && (clamped < clip.timelineEndSec || isLast);
  });
  const resolvedIndex = clipIndex >= 0 ? clipIndex : clips.length - 1;
  const clip = clips[resolvedIndex];
  const clipOffset = Math.max(0, Math.min(clip.sourceEndSec - clip.sourceStartSec, clamped - clip.timelineStartSec));
  return {
    clip,
    clipIndex: resolvedIndex,
    virtualTimeSec: clamped,
    sourceTimeSec: clip.sourceStartSec + clipOffset,
  };
}

export function locateSourcePosition(clips: AxcutClip[], sourceTimeSec: number, epsilon = 0.05): VirtualPosition | null {
  const clipIndex = clips.findIndex((clip, index) => {
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

export function resolvePlaybackPosition(clips: AxcutClip[], sourceTimeSec: number, epsilon = 0.05): PlaybackPosition {
  const position = locateSourcePosition(clips, sourceTimeSec, epsilon);
  if (position) {
    return { kind: 'inside', position };
  }

  const nextClip = clips.find((clip) => clip.sourceStartSec > sourceTimeSec);
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
