import type { AxcutClip, AxcutDocument, AxcutTimelineOperation, AxcutTranscript } from '@axcut/schema';

type OperationOrigin = 'system' | 'agent' | 'user';
type TimeInterval = { startSec: number; endSec: number };

function byStart(a: { startSec: number }, b: { startSec: number }): number {
  return a.startSec - b.startSec;
}

function normalizeIntervals(durationSec: number, intervals: TimeInterval[]): TimeInterval[] {
  const bounded = intervals
    .map((interval) => ({
      startSec: Math.max(0, Math.min(durationSec, interval.startSec)),
      endSec: Math.max(0, Math.min(durationSec, interval.endSec)),
    }))
    .filter((interval) => interval.endSec > interval.startSec)
    .sort(byStart);

  const merged: TimeInterval[] = [];
  for (const interval of bounded) {
    const previous = merged.at(-1);
    if (!previous || interval.startSec > previous.endSec) {
      merged.push({ ...interval });
      continue;
    }
    previous.endSec = Math.max(previous.endSec, interval.endSec);
  }
  return merged;
}

function primaryAssetId(document: AxcutDocument): string | null {
  return document.project.primaryAssetId ?? document.assets[0]?.id ?? null;
}

function primaryAssetDuration(document: AxcutDocument): number {
  const asset = document.assets.find((item) => item.id === document.project.primaryAssetId) ?? document.assets[0];
  return asset?.durationSec ?? 0;
}

function documentTranscripts(document: AxcutDocument): AxcutTranscript[] {
  return document.transcripts.length > 0
    ? document.transcripts
    : document.transcript ? [document.transcript] : [];
}

function transcriptForAsset(document: AxcutDocument, assetId: string): AxcutTranscript | null {
  return documentTranscripts(document).find((transcript) => transcript.assetId === assetId) ?? null;
}

function collectWordRefs(
  transcripts: AxcutTranscript[] | AxcutTranscript | null,
  assetId: string,
  startSec: number,
  endSec: number,
): string[] {
  const transcript = Array.isArray(transcripts)
    ? transcripts.find((item) => item.assetId === assetId) ?? null
    : transcripts;
  if (!transcript) {
    return [];
  }
  return transcript.words
    .filter((word) => (word.assetId ?? transcript.assetId) === assetId && word.endSec > startSec && word.startSec < endSec)
    .map((word) => word.id);
}

function buildTimelineFromIntervals(
  assetId: string,
  intervals: TimeInterval[],
  options: { origin: OperationOrigin; reason: string; transcript: AxcutTranscript | null },
): AxcutClip[] {
  let cursor = 0;
  return intervals.map((interval, index) => {
    const duration = interval.endSec - interval.startSec;
    const clip: AxcutClip = {
      id: `clip_${index + 1}`,
      assetId,
      sourceStartSec: interval.startSec,
      sourceEndSec: interval.endSec,
      timelineStartSec: cursor,
      timelineEndSec: cursor + duration,
      wordRefs: collectWordRefs(options.transcript, assetId, interval.startSec, interval.endSec),
      origin: options.origin,
      reason: options.reason,
    };
    cursor = clip.timelineEndSec;
    return clip;
  });
}

function retimeClips(clips: AxcutClip[], transcripts: AxcutTranscript[]): AxcutClip[] {
  let cursor = 0;
  let generatedIndex = 1;
  const usedIds = new Set<string>();
  const reservedIds = new Set(clips.map((clip) => clip.id).filter(Boolean));

  const nextClipId = () => {
    while (usedIds.has(`clip_${generatedIndex}`) || reservedIds.has(`clip_${generatedIndex}`)) {
      generatedIndex += 1;
    }
    const id = `clip_${generatedIndex}`;
    generatedIndex += 1;
    usedIds.add(id);
    return id;
  };

  return clips
    .filter((clip) => clip.sourceEndSec > clip.sourceStartSec)
    .map((clip) => {
      const duration = clip.sourceEndSec - clip.sourceStartSec;
      const id = clip.id && !usedIds.has(clip.id) ? clip.id : nextClipId();
      usedIds.add(id);
      const next: AxcutClip = {
        ...clip,
        id,
        timelineStartSec: cursor,
        timelineEndSec: cursor + duration,
        wordRefs: collectWordRefs(transcripts, clip.assetId, clip.sourceStartSec, clip.sourceEndSec),
      };
      cursor = next.timelineEndSec;
      return next;
    });
}

function subtractInterval(intervals: TimeInterval[], cut: TimeInterval): TimeInterval[] {
  const output: TimeInterval[] = [];
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

function applySourceCutToAsset(
  clips: AxcutClip[],
  assetId: string,
  cut: TimeInterval,
  origin: OperationOrigin,
  reason: string,
): AxcutClip[] {
  const output: AxcutClip[] = [];
  for (const clip of clips) {
    if (clip.assetId !== assetId || cut.endSec <= clip.sourceStartSec || cut.startSec >= clip.sourceEndSec) {
      output.push(clip);
      continue;
    }
    const remaining = subtractInterval([{ startSec: clip.sourceStartSec, endSec: clip.sourceEndSec }], cut);
    for (const interval of remaining) {
      output.push({
        ...clip,
        sourceStartSec: interval.startSec,
        sourceEndSec: interval.endSec,
        origin,
        reason,
      });
    }
  }
  return output;
}

function resolveWordRange(
  document: AxcutDocument,
  startWordId: string,
  endWordId: string,
): { assetId: string; startSec: number; endSec: number } | null {
  const words = documentTranscripts(document).flatMap((transcript) => transcript.words.map((word) => ({
    ...word,
    assetId: word.assetId ?? transcript.assetId,
  })));
  const start = words.find((word) => word.id === startWordId);
  const end = words.find((word) => word.id === endWordId);
  if (!start || !end || !start.assetId || start.assetId !== end.assetId) {
    return null;
  }
  return {
    assetId: start.assetId,
    startSec: Math.min(start.startSec, end.startSec),
    endSec: Math.max(start.endSec, end.endSec),
  };
}

function addSkipRange(
  document: AxcutDocument,
  input: { assetId: string; startSec: number; endSec: number; reason: string },
  origin: OperationOrigin,
): AxcutDocument['timeline']['skipRanges'] {
  const asset = document.assets.find((item) => item.id === input.assetId);
  if (!asset) {
    return document.timeline.skipRanges;
  }
  const startSec = Math.max(0, Math.min(input.startSec, input.endSec));
  const assetDuration = asset.durationSec ?? Number.POSITIVE_INFINITY;
  const endSec = Math.max(startSec, Math.min(Math.max(input.startSec, input.endSec), assetDuration));
  if (endSec <= startSec) {
    return document.timeline.skipRanges;
  }
  return [
    ...document.timeline.skipRanges,
    {
      id: `skip_${document.timeline.skipRanges.length + 1}`,
      assetId: input.assetId,
      startSec,
      endSec,
      reason: input.reason,
      origin,
    },
  ];
}

function updateSkipRange(
  document: AxcutDocument,
  input: { skipId: string; startSec: number; endSec: number; reason: string },
): AxcutDocument['timeline']['skipRanges'] {
  return document.timeline.skipRanges.map((skip) => {
    if (skip.id !== input.skipId) {
      return skip;
    }
    const asset = document.assets.find((item) => item.id === skip.assetId);
    const assetDuration = asset?.durationSec ?? Number.POSITIVE_INFINITY;
    const startSec = Math.max(0, Math.min(input.startSec, input.endSec));
    const endSec = Math.max(startSec, Math.min(Math.max(input.startSec, input.endSec), assetDuration));
    return {
      ...skip,
      startSec,
      endSec,
      reason: input.reason || skip.reason,
    };
  }).filter((skip) => skip.endSec > skip.startSec);
}

function updateClipRange(
  document: AxcutDocument,
  input: { clipId: string; sourceStartSec: number; sourceEndSec: number; reason: string },
  origin: OperationOrigin,
): AxcutClip[] | null {
  let found = false;
  const nextClips = document.timeline.clips.map((clip) => {
    if (clip.id !== input.clipId) {
      return clip;
    }
    found = true;
    const asset = document.assets.find((item) => item.id === clip.assetId);
    const assetDuration = asset?.durationSec ?? Number.POSITIVE_INFINITY;
    const sourceStartSec = Math.max(0, Math.min(input.sourceStartSec, input.sourceEndSec));
    const sourceEndSec = Math.max(sourceStartSec, Math.min(Math.max(input.sourceStartSec, input.sourceEndSec), assetDuration));
    return {
      ...clip,
      sourceStartSec,
      sourceEndSec,
      origin,
      reason: input.reason || clip.reason,
    };
  });
  return found ? retimeClips(nextClips, documentTranscripts(document)) : null;
}

function duplicateClip(document: AxcutDocument, clipId: string, origin: OperationOrigin, reason: string): AxcutClip[] | null {
  const index = document.timeline.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) {
    return null;
  }
  const source = document.timeline.clips[index];
  const copy: AxcutClip = {
    ...source,
    id: `${source.id}_copy`,
    origin,
    reason,
  };
  return retimeClips([
    ...document.timeline.clips.slice(0, index + 1),
    copy,
    ...document.timeline.clips.slice(index + 1),
  ], documentTranscripts(document));
}

function moveClip(
  document: AxcutDocument,
  clipId: string,
  insertIndex: number,
  origin: OperationOrigin,
  reason: string,
): AxcutClip[] | null {
  const index = document.timeline.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) {
    return null;
  }
  const movingClip = {
    ...document.timeline.clips[index],
    origin,
    reason,
  };
  const remainingClips = document.timeline.clips.filter((clip) => clip.id !== clipId);
  const boundedInsertIndex = Math.max(0, Math.min(insertIndex, remainingClips.length));
  return retimeClips([
    ...remainingClips.slice(0, boundedInsertIndex),
    movingClip,
    ...remainingClips.slice(boundedInsertIndex),
  ], documentTranscripts(document));
}

function buildFullAssetClip(
  document: AxcutDocument,
  operation: Extract<AxcutTimelineOperation, { type: 'insert_asset_clip' }>,
  origin: OperationOrigin,
): AxcutClip | null {
  const asset = document.assets.find((item) => item.id === operation.assetId);
  if (!asset) {
    return null;
  }
  const sourceStartSec = operation.sourceStartSec ?? 0;
  const sourceEndSec = operation.sourceEndSec ?? asset.durationSec;
  if (sourceEndSec === undefined || sourceEndSec <= sourceStartSec) {
    return null;
  }
  return {
    id: 'clip_pending',
    assetId: operation.assetId,
    sourceStartSec,
    sourceEndSec,
    timelineStartSec: 0,
    timelineEndSec: sourceEndSec - sourceStartSec,
    wordRefs: collectWordRefs(documentTranscripts(document), operation.assetId, sourceStartSec, sourceEndSec),
    origin,
    reason: operation.reason,
  };
}

function findInsertionIndex(clips: AxcutClip[], insertAtSec: number, mode: 'before' | 'after'): number {
  const containingIndex = clips.findIndex((clip, index) => {
    const isLast = index === clips.length - 1;
    return insertAtSec >= clip.timelineStartSec && (insertAtSec < clip.timelineEndSec || isLast);
  });
  if (containingIndex < 0) {
    return insertAtSec >= (clips.at(-1)?.timelineEndSec ?? 0) ? clips.length : 0;
  }
  return mode === 'before' ? containingIndex : containingIndex + 1;
}

function insertAssetClip(
  document: AxcutDocument,
  operation: Extract<AxcutTimelineOperation, { type: 'insert_asset_clip' }>,
  origin: OperationOrigin,
): AxcutClip[] | null {
  const inserted = buildFullAssetClip(document, operation, origin);
  if (!inserted) {
    return null;
  }
  const clips = document.timeline.clips;
  if (operation.mode !== 'split' || clips.length === 0) {
    const mode = operation.mode === 'split' ? 'after' : operation.mode;
    const index = findInsertionIndex(clips, operation.insertAtSec, mode);
    return retimeClips([...clips.slice(0, index), inserted, ...clips.slice(index)], documentTranscripts(document));
  }

  const index = findInsertionIndex(clips, operation.insertAtSec, 'before');
  const target = clips[index];
  if (!target || operation.insertAtSec <= target.timelineStartSec || operation.insertAtSec >= target.timelineEndSec) {
    return retimeClips([...clips.slice(0, index), inserted, ...clips.slice(index)], documentTranscripts(document));
  }
  const splitOffsetSec = operation.insertAtSec - target.timelineStartSec;
  const sourceSplitSec = target.sourceStartSec + splitOffsetSec;
  return retimeClips([
    ...clips.slice(0, index),
    { ...target, sourceEndSec: sourceSplitSec },
    inserted,
    { ...target, sourceStartSec: sourceSplitSec },
    ...clips.slice(index + 1),
  ], documentTranscripts(document));
}

export function applyOptimisticTimelineOperation(
  document: AxcutDocument,
  operation: AxcutTimelineOperation,
  origin: OperationOrigin = operation.type === 'replace_timeline' ? 'agent' : 'user',
): AxcutDocument {
  const assetId = primaryAssetId(document);
  const duration = primaryAssetDuration(document);
  let nextClips = document.timeline.clips;
  let nextSkipRanges = document.timeline.skipRanges;

  switch (operation.type) {
    case 'replace_timeline':
      if (!assetId) {
        return document;
      }
      nextClips = buildTimelineFromIntervals(assetId, normalizeIntervals(duration, operation.intervals), {
        origin,
        reason: operation.reason,
        transcript: transcriptForAsset(document, assetId),
      });
      break;
    case 'drop_range': {
      const resolvedAssetId = operation.assetId ?? assetId;
      if (!resolvedAssetId) {
        return document;
      }
      nextClips = retimeClips(
        applySourceCutToAsset(nextClips, resolvedAssetId, { startSec: operation.startSec, endSec: operation.endSec }, origin, operation.reason),
        documentTranscripts(document),
      );
      break;
    }
    case 'drop_word_range': {
      const range = resolveWordRange(document, operation.startWordId, operation.endWordId);
      if (!range) {
        return document;
      }
      nextSkipRanges = addSkipRange(document, { ...range, reason: operation.reason }, origin);
      nextClips = retimeClips(nextClips, documentTranscripts(document));
      break;
    }
    case 'add_skip_range':
      nextSkipRanges = addSkipRange(document, operation, origin);
      nextClips = retimeClips(nextClips, documentTranscripts(document));
      break;
    case 'update_skip_range':
      nextSkipRanges = updateSkipRange(document, operation);
      nextClips = retimeClips(nextClips, documentTranscripts(document));
      break;
    case 'remove_skip_range':
      nextSkipRanges = document.timeline.skipRanges.filter((skip) => skip.id !== operation.skipId);
      nextClips = retimeClips(nextClips, documentTranscripts(document));
      break;
    case 'update_clip_range': {
      const updated = updateClipRange(document, operation, origin);
      if (!updated) {
        return document;
      }
      nextClips = updated;
      break;
    }
    case 'duplicate_clip': {
      const duplicated = duplicateClip(document, operation.clipId, origin, operation.reason);
      if (!duplicated) {
        return document;
      }
      nextClips = duplicated;
      break;
    }
    case 'move_clip': {
      const moved = moveClip(document, operation.clipId, operation.insertIndex, origin, operation.reason);
      if (!moved) {
        return document;
      }
      nextClips = moved;
      break;
    }
    case 'restore_full_timeline':
      if (!assetId) {
        return document;
      }
      nextClips = duration > 0
        ? buildTimelineFromIntervals(assetId, [{ startSec: 0, endSec: duration }], {
          origin,
          reason: operation.reason,
          transcript: transcriptForAsset(document, assetId),
        })
        : [];
      break;
    case 'insert_asset_clip': {
      const inserted = insertAssetClip(document, operation, origin);
      if (!inserted) {
        return document;
      }
      nextClips = inserted;
      break;
    }
  }

  return {
    ...document,
    timeline: {
      ...document.timeline,
      clips: nextClips,
      skipRanges: nextSkipRanges,
      gaps: [],
    },
    preview: {
      ...document.preview,
      revision: document.preview.revision + 1,
    },
  };
}
