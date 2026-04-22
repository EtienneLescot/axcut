import type { AxcutClip, AxcutDocument, AxcutOperation, AxcutTranscript } from '@axcut/schema';

function byStart(a: { startSec: number }, b: { startSec: number }): number {
  return a.startSec - b.startSec;
}

export function normalizeIntervals(durationSec: number, intervals: Array<{ startSec: number; endSec: number }>): Array<{ startSec: number; endSec: number }> {
  const bounded = intervals
    .map((item) => ({
      startSec: Math.max(0, Math.min(durationSec, item.startSec)),
      endSec: Math.max(0, Math.min(durationSec, item.endSec)),
    }))
    .filter((item) => item.endSec > item.startSec)
    .sort(byStart);

  const merged: Array<{ startSec: number; endSec: number }> = [];
  for (const item of bounded) {
    const last = merged.at(-1);
    if (!last || item.startSec > last.endSec) {
      merged.push({ ...item });
      continue;
    }
    last.endSec = Math.max(last.endSec, item.endSec);
  }
  return merged;
}

export function timelineIntervals(document: AxcutDocument): Array<{ startSec: number; endSec: number }> {
  return normalizeIntervals(
    primaryAssetDuration(document),
    document.timeline.clips.map((clip) => ({ startSec: clip.sourceStartSec, endSec: clip.sourceEndSec })),
  );
}

export function primaryAssetDuration(document: AxcutDocument): number {
  const asset = document.assets.find((item) => item.id === document.project.primaryAssetId) ?? document.assets[0];
  return asset?.durationSec ?? 0;
}

export function buildTimelineFromIntervals(
  assetId: string,
  intervals: Array<{ startSec: number; endSec: number }>,
  options: { origin: 'system' | 'agent' | 'user'; reason: string; transcript: AxcutTranscript | null },
): AxcutClip[] {
  let cursor = 0;
  return intervals.map((interval, index) => {
    const duration = interval.endSec - interval.startSec;
    const timelineStartSec = cursor;
    const timelineEndSec = cursor + duration;
    cursor = timelineEndSec;
    return {
      id: `clip_${index + 1}`,
      assetId,
      sourceStartSec: interval.startSec,
      sourceEndSec: interval.endSec,
      timelineStartSec,
      timelineEndSec,
      wordRefs: collectWordRefs(options.transcript, interval.startSec, interval.endSec),
      origin: options.origin,
      reason: options.reason,
    };
  });
}

function collectWordRefs(
  transcript: AxcutTranscript | null,
  startSec: number,
  endSec: number,
): string[] {
  if (!transcript) {
    return [];
  }
  return transcript.words
    .filter((word) => word.endSec > startSec && word.startSec < endSec)
    .map((word) => word.id);
}

export function subtractInterval(
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

export function resolveWordRange(
  document: AxcutDocument,
  startWordId: string,
  endWordId: string,
): { startSec: number; endSec: number } {
  const words = document.transcript?.words ?? [];
  const start = words.find((word) => word.id === startWordId);
  const end = words.find((word) => word.id === endWordId);
  if (!start || !end) {
    throw new Error('Unknown transcript word id in operation.');
  }
  return {
    startSec: Math.min(start.startSec, end.startSec),
    endSec: Math.max(start.endSec, end.endSec),
  };
}

export function applyTimelineOperation(
  document: AxcutDocument,
  operation: AxcutOperation,
  origin: 'system' | 'agent' | 'user' = operation.type === 'replace_timeline' ? 'agent' : 'user',
): AxcutDocument {
  const assetId = document.project.primaryAssetId ?? document.assets[0]?.id;
  if (!assetId) {
    throw new Error('Cannot update timeline without a primary asset.');
  }

  let nextIntervals = timelineIntervals(document);
  const duration = primaryAssetDuration(document);
  if (nextIntervals.length === 0 && duration > 0) {
    nextIntervals = [{ startSec: 0, endSec: duration }];
  }

  switch (operation.type) {
    case 'replace_timeline':
      nextIntervals = normalizeIntervals(duration, operation.intervals);
      break;
    case 'drop_range':
      nextIntervals = subtractInterval(nextIntervals, { startSec: operation.startSec, endSec: operation.endSec });
      break;
    case 'drop_word_range': {
      const range = resolveWordRange(document, operation.startWordId, operation.endWordId);
      nextIntervals = subtractInterval(nextIntervals, range);
      break;
    }
    case 'restore_full_timeline':
      nextIntervals = duration > 0 ? [{ startSec: 0, endSec: duration }] : [];
      break;
  }

  return {
    ...document,
    timeline: {
      ...document.timeline,
      clips: buildTimelineFromIntervals(assetId, nextIntervals, {
        origin,
        reason: operation.reason,
        transcript: document.transcript,
      }),
      gaps: [],
    },
    preview: {
      ...document.preview,
      revision: document.preview.revision + 1,
    },
  };
}
