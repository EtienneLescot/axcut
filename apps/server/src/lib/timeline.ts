import { normalizeSkipRanges, type AxcutClip, type AxcutDocument, type AxcutOperation, type AxcutTimelineOperation, type AxcutTranscript } from '@axcut/schema';

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
  const assetId = document.project.primaryAssetId ?? document.assets[0]?.id;
  return normalizeIntervals(
    primaryAssetDuration(document),
    document.timeline.clips
      .filter((clip) => !assetId || clip.assetId === assetId)
      .map((clip) => ({ startSec: clip.sourceStartSec, endSec: clip.sourceEndSec })),
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
      wordRefs: collectWordRefs(options.transcript, assetId, interval.startSec, interval.endSec),
      origin: options.origin,
      reason: options.reason,
    };
  });
}

function collectWordRefs(
  transcript: AxcutTranscript | AxcutTranscript[] | null,
  assetId: string,
  startSec: number,
  endSec: number,
): string[] {
  const resolvedTranscript = Array.isArray(transcript)
    ? transcript.find((item) => item.assetId === assetId) ?? null
    : transcript;
  if (!resolvedTranscript) {
    return [];
  }
  return resolvedTranscript.words
    .filter((word) => (word.assetId ?? resolvedTranscript.assetId) === assetId && word.endSec > startSec && word.startSec < endSec)
    .map((word) => word.id);
}

export function retimeClips(clips: AxcutClip[], transcript: AxcutTranscript | AxcutTranscript[] | null = null): AxcutClip[] {
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
        wordRefs: collectWordRefs(transcript, clip.assetId, clip.sourceStartSec, clip.sourceEndSec),
      };
      cursor = next.timelineEndSec;
      return next;
    });
}

function documentTranscripts(document: AxcutDocument): AxcutTranscript[] {
  return document.transcripts.length > 0
    ? document.transcripts
    : document.transcript ? [document.transcript] : [];
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
): { assetId: string; startSec: number; endSec: number } {
  const transcripts = documentTranscripts(document);
  const candidates = transcripts.flatMap((transcript) => {
    const start = transcript.words.find((word) => word.id === startWordId);
    const end = transcript.words.find((word) => word.id === endWordId);
    if (!start || !end) {
      return [];
    }
    const assetId = start.assetId ?? transcript.assetId;
    if ((end.assetId ?? transcript.assetId) !== assetId) {
      return [];
    }
    return [{
      assetId,
      startSec: Math.min(start.startSec, end.startSec),
      endSec: Math.max(start.endSec, end.endSec),
    }];
  });
  if (candidates.length === 0) {
    throw new Error('Unknown transcript word id in operation.');
  }
  const mountedAssetIds = new Set(document.timeline.clips.map((clip) => clip.assetId));
  const mountedCandidates = candidates.filter((candidate) => mountedAssetIds.has(candidate.assetId));
  const viableCandidates = mountedCandidates.length > 0 ? mountedCandidates : candidates;
  if (viableCandidates.length > 1) {
    throw new Error('Transcript word id range is ambiguous across multiple assets; use add_skip_range with assetId and timestamps.');
  }
  return viableCandidates[0]!;
}

function primaryAssetId(document: AxcutDocument): string {
  const assetId = document.project.primaryAssetId ?? document.assets[0]?.id;
  if (!assetId) {
    throw new Error('Cannot update timeline without a primary asset.');
  }
  return assetId;
}

function applySourceCutToAsset(
  clips: AxcutClip[],
  assetId: string,
  cut: { startSec: number; endSec: number },
  origin: 'system' | 'agent' | 'user',
  reason: string,
): AxcutClip[] {
  const output: AxcutClip[] = [];
  for (const clip of clips) {
    if (clip.assetId !== assetId || cut.endSec <= clip.sourceStartSec || cut.startSec >= clip.sourceEndSec) {
      output.push(clip);
      continue;
    }
    if (cut.startSec > clip.sourceStartSec) {
      output.push({ ...clip, sourceEndSec: cut.startSec, origin, reason });
    }
    if (cut.endSec < clip.sourceEndSec) {
      output.push({ ...clip, sourceStartSec: cut.endSec, origin, reason });
    }
  }
  return output;
}

function addSkipRange(
  document: AxcutDocument,
  input: { assetId: string; startSec: number; endSec: number; reason: string },
  origin: 'system' | 'agent' | 'user',
): AxcutDocument['timeline']['skipRanges'] {
  const asset = document.assets.find((item) => item.id === input.assetId);
  if (!asset) {
    throw new Error(`Unknown asset ${input.assetId}.`);
  }
  const startSec = Math.max(0, Math.min(input.startSec, input.endSec));
  const assetDuration = asset.durationSec ?? Number.POSITIVE_INFINITY;
  const endSec = Math.max(startSec, Math.min(Math.max(input.startSec, input.endSec), assetDuration));
  if (endSec <= startSec) {
    return document.timeline.skipRanges;
  }
  return normalizeSkipRanges([
    ...document.timeline.skipRanges,
    {
      id: `skip_${document.timeline.skipRanges.length + 1}`,
      assetId: input.assetId,
      startSec,
      endSec,
      reason: input.reason,
      origin,
    },
  ]);
}

function updateSkipRange(
  document: AxcutDocument,
  input: { skipId: string; startSec: number; endSec: number; reason: string },
): AxcutDocument['timeline']['skipRanges'] {
  return normalizeSkipRanges(document.timeline.skipRanges.map((skip) => {
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
  }).filter((skip) => skip.endSec > skip.startSec));
}

function updateClipRange(
  document: AxcutDocument,
  input: { clipId: string; sourceStartSec: number; sourceEndSec: number; reason: string },
  origin: 'system' | 'agent' | 'user',
): AxcutClip[] {
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
  if (!found) {
    throw new Error(`Unknown clip ${input.clipId}.`);
  }
  return retimeClips(nextClips, documentTranscripts(document));
}

function duplicateClip(
  document: AxcutDocument,
  clipId: string,
  origin: 'system' | 'agent' | 'user',
  reason: string,
): AxcutClip[] {
  const index = document.timeline.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) {
    throw new Error(`Unknown clip ${clipId}.`);
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
  origin: 'system' | 'agent' | 'user',
  reason: string,
): AxcutClip[] {
  const index = document.timeline.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) {
    throw new Error(`Unknown clip ${clipId}.`);
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

function buildFullAssetClip(document: AxcutDocument, operation: Extract<AxcutTimelineOperation, { type: 'insert_asset_clip' }>, origin: 'system' | 'agent' | 'user'): AxcutClip {
  const asset = document.assets.find((item) => item.id === operation.assetId);
  if (!asset) {
    throw new Error(`Unknown asset ${operation.assetId}.`);
  }
  const sourceStartSec = operation.sourceStartSec ?? 0;
  const sourceEndSec = operation.sourceEndSec ?? asset.durationSec;
  if (sourceEndSec === undefined || sourceEndSec <= sourceStartSec) {
    throw new Error('Cannot insert an asset before media metadata is available.');
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
  origin: 'system' | 'agent' | 'user',
): AxcutClip[] {
  const inserted = buildFullAssetClip(document, operation, origin);
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

export function applyTimelineOperation(
  document: AxcutDocument,
  operation: AxcutOperation,
  origin: 'system' | 'agent' | 'user' = operation.type === 'replace_timeline' ? 'agent' : 'user',
): AxcutDocument {
  const assetId = primaryAssetId(document);
  const duration = primaryAssetDuration(document);
  let nextClips = document.timeline.clips;
  let nextSkipRanges = document.timeline.skipRanges;

  switch (operation.type) {
    case 'replace_timeline':
      nextClips = buildTimelineFromIntervals(assetId, normalizeIntervals(duration, operation.intervals), {
        origin,
        reason: operation.reason,
        transcript: documentTranscripts(document).find((transcript) => transcript.assetId === assetId) ?? null,
      });
      break;
    case 'drop_range':
      nextClips = retimeClips(
        applySourceCutToAsset(nextClips, operation.assetId ?? assetId, { startSec: operation.startSec, endSec: operation.endSec }, origin, operation.reason),
        documentTranscripts(document),
      );
      break;
    case 'drop_word_range': {
      const range = resolveWordRange(document, operation.startWordId, operation.endWordId);
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
      nextSkipRanges = normalizeSkipRanges(document.timeline.skipRanges.filter((skip) => skip.id !== operation.skipId));
      nextClips = retimeClips(nextClips, documentTranscripts(document));
      break;
    case 'update_clip_range':
      nextClips = updateClipRange(document, operation, origin);
      break;
    case 'duplicate_clip':
      nextClips = duplicateClip(document, operation.clipId, origin, operation.reason);
      break;
    case 'move_clip':
      nextClips = moveClip(document, operation.clipId, operation.insertIndex, origin, operation.reason);
      break;
    case 'restore_full_timeline':
      nextClips = duration > 0
        ? buildTimelineFromIntervals(assetId, [{ startSec: 0, endSec: duration }], {
          origin,
          reason: operation.reason,
          transcript: documentTranscripts(document).find((transcript) => transcript.assetId === assetId) ?? null,
        })
        : [];
      break;
    case 'insert_asset_clip':
      nextClips = insertAssetClip(document, operation, origin);
      break;
  }

  return {
    ...document,
    timeline: {
      ...document.timeline,
      clips: nextClips,
      skipRanges: normalizeSkipRanges(nextSkipRanges),
      gaps: [],
    },
    preview: {
      ...document.preview,
      revision: document.preview.revision + 1,
    },
  };
}
