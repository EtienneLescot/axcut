import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { Pencil, Scissors, Trash2, X } from 'lucide-react';
import type { AxcutAsset, AxcutClip, AxcutTimeline } from '@axcut/schema';

import { VirtualPreview } from './VirtualPreview.js';
import { formatSeconds, locateVirtualPosition, totalVirtualDuration } from '../lib/virtual-preview.js';

type VideoSource = { assetId: string; src: string; label: string };

type TimelinePaneProps = {
  clips: AxcutClip[];
  assets: AxcutAsset[];
  videoSources?: VideoSource[];
  previewRevision?: number;
  skipRanges?: AxcutTimeline['skipRanges'];
  currentTimeSec: number;
  busy?: boolean;
  onSeek: (timeSec: number) => void;
  onPreviewSource: (sourceTimeSec: number, assetId?: string) => void;
  onAddSkipRange?: (assetId: string, startSec: number, endSec: number, reason: string) => void;
  onUpdateSkipRange?: (skipId: string, startSec: number, endSec: number, reason: string) => void;
  onRemoveSkipRange?: (skipId: string) => void;
  onUpdateClipRange?: (clipId: string, sourceStartSec: number, sourceEndSec: number, reason: string) => void;
  onDuplicateClip?: (clipId: string) => void;
  onMoveClip?: (clipId: string, insertIndex: number) => void;
  onAssetDrop?: (input: { assetId: string; insertAtSec: number }) => void;
};

type SourceRange = {
  id: string;
  startSec: number;
  endSec: number;
  assetId?: string;
  sourceStartSec?: number;
  sourceEndSec?: number;
  label?: string;
};

type TimelineKeptItem = SourceRange & {
  kind: 'kept';
  clipId: string;
  canResizeClipStart: boolean;
  canResizeClipEnd: boolean;
};

type TimelineSkipItem = SourceRange & {
  kind: 'skip';
  clipId: string;
  skipId: string;
  reason: string;
  canResizeStart: boolean;
  canResizeEnd: boolean;
};

type TimelineItem = TimelineKeptItem | TimelineSkipItem;

type ResizeState = {
  id: number;
  target: 'skip' | 'clip';
  itemId: string;
  edge: 'start' | 'end';
  startClientX: number;
  startSec: number;
  endSec: number;
  currentStartSec: number;
  currentEndSec: number;
  minStartSec: number;
  maxEndSec: number;
  pxPerSec: number;
};

type PanState = {
  startClientX: number;
  startScrollLeft: number;
};

type NavigatorDragState = {
  mode: 'move' | 'start' | 'end';
  startClientX: number;
  overviewWidthPx: number;
  startVisibleStartSec: number;
  startVisibleEndSec: number;
};

type ClipReorderState = {
  clipId: string;
  startClientX: number;
  startClientY: number;
  currentClientX: number;
  currentClientY: number;
  insertIndex: number;
  dragging: boolean;
};

const MIN_CUT_DURATION_SEC = 0.1;
const MIN_SOURCE_DURATION_SEC = 0.001;
const MAX_PX_PER_SEC = 280;
const MIN_SEGMENT_WIDTH_PX = 1;
const RULER_HEIGHT_PX = 28;
const CLIP_REORDER_THRESHOLD_PX = 6;

export function TimelinePane({
  clips,
  assets,
  videoSources = [],
  previewRevision = 0,
  skipRanges = [],
  currentTimeSec,
  busy = false,
  onSeek,
  onPreviewSource,
  onAddSkipRange,
  onUpdateSkipRange,
  onRemoveSkipRange,
  onUpdateClipRange,
  onDuplicateClip,
  onMoveClip,
  onAssetDrop,
}: TimelinePaneProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const overviewRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const navigatorDragRef = useRef<NavigatorDragState | null>(null);
  const clipReorderRef = useRef<ClipReorderState | null>(null);
  const resizeSequenceRef = useRef(0);
  const [viewportWidthPx, setViewportWidthPx] = useState(0);
  const [scrollLeftPx, setScrollLeftPx] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [panning, setPanning] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [navigatorDragging, setNavigatorDragging] = useState(false);
  const [pendingCutPlacement, setPendingCutPlacement] = useState(false);
  const [pendingCutPreviewSec, setPendingCutPreviewSec] = useState<number | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [clipEditId, setClipEditId] = useState<string | null>(null);
  const [copiedClipId, setCopiedClipId] = useState<string | null>(null);
  const [clipReorderState, setClipReorderState] = useState<ClipReorderState | null>(null);

  const virtualDurationSec = totalVirtualDuration(clips);
  const activePosition = locateVirtualPosition(clips, currentTimeSec);
  const assetLabelById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset.label])), [assets]);
  const assetDurationById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset.durationSec ?? virtualDurationSec])), [assets, virtualDurationSec]);
  const sourceDuration = useMemo(
    () => Math.max(virtualDurationSec, MIN_SOURCE_DURATION_SEC),
    [virtualDurationSec],
  );
  const fitPxPerSec = useMemo(() => (
    Math.max(0.001, viewportWidthPx / Math.max(sourceDuration, MIN_SOURCE_DURATION_SEC))
  ), [sourceDuration, viewportWidthPx]);
  const pxPerSec = clamp(fitPxPerSec * zoom, fitPxPerSec, MAX_PX_PER_SEC);
  const contentWidthPx = Math.max(viewportWidthPx, Math.ceil(sourceDuration * pxPerSec));
  const visibleStartSec = clamp(scrollLeftPx / Math.max(pxPerSec, 0.001), 0, sourceDuration);
  const visibleDurationSec = clamp(viewportWidthPx / Math.max(pxPerSec, 0.001), 0, sourceDuration);
  const visibleEndSec = clamp(visibleStartSec + visibleDurationSec, 0, sourceDuration);
  const navigatorWindowStyle = useMemo(() => ({
    left: `${(visibleStartSec / Math.max(sourceDuration, MIN_SOURCE_DURATION_SEC)) * 100}%`,
    width: `${Math.max(0, ((visibleEndSec - visibleStartSec) / Math.max(sourceDuration, MIN_SOURCE_DURATION_SEC)) * 100)}%`,
  }) as CSSProperties, [sourceDuration, visibleEndSec, visibleStartSec]);

  const skipItems = useMemo(
    () => buildTimelineSkipItems(clips, skipRanges, assetLabelById, sourceDuration, resizeState),
    [assetLabelById, clips, resizeState, skipRanges, sourceDuration],
  );
  const timelineItems = useMemo(
    () => buildTimelineItems(clips, skipRanges, assetLabelById, sourceDuration, resizeState),
    [assetLabelById, clips, resizeState, skipRanges, sourceDuration],
  );
  const rulerTicks = useMemo(() => buildRulerTicks(sourceDuration, pxPerSec), [pxPerSec, sourceDuration]);
  const playheadSourceSec = activePosition?.virtualTimeSec ?? null;
  const assetCount = useMemo(() => new Set(clips.map((clip) => clip.assetId)).size, [clips]);
  const orderedClips = useMemo(() => [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec), [clips]);
  const clipById = useMemo(() => new Map(clips.map((clip) => [clip.id, clip])), [clips]);
  const clipEditClip = useMemo(
    () => clips.find((clip) => clip.id === clipEditId) ?? null,
    [clipEditId, clips],
  );

  useEffect(() => {
    if (clipEditId && !clips.some((clip) => clip.id === clipEditId)) {
      setClipEditId(null);
    }
  }, [clipEditId, clips]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }
    const updateWidth = () => setViewportWidthPx(scrollElement.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    resizeRef.current = resizeState;
  }, [resizeState]);

  const sourceSecFromClientX = useCallback((clientX: number) => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return null;
    }
    const rect = scrollElement.getBoundingClientRect();
    return clamp((scrollElement.scrollLeft + clientX - rect.left) / Math.max(pxPerSec, 0.001), 0, sourceDuration);
  }, [pxPerSec, sourceDuration]);

  const insertionIndexFromClientX = useCallback((clientX: number, clipId: string) => {
    const timelineSec = sourceSecFromClientX(clientX) ?? 0;
    const remainingClips = orderedClips.filter((clip) => clip.id !== clipId);
    for (let index = 0; index < remainingClips.length; index += 1) {
      const clip = remainingClips[index];
      const midpointSec = (clip.timelineStartSec + clip.timelineEndSec) / 2;
      if (timelineSec < midpointSec) {
        return index;
      }
    }
    return remainingClips.length;
  }, [orderedClips, sourceSecFromClientX]);

  const isReorderNoop = useCallback((clipId: string, insertIndex: number) => {
    const currentIds = orderedClips.map((clip) => clip.id);
    const movingClip = orderedClips.find((clip) => clip.id === clipId);
    if (!movingClip) {
      return true;
    }
    const remainingIds = currentIds.filter((id) => id !== clipId);
    const nextIds = [
      ...remainingIds.slice(0, insertIndex),
      clipId,
      ...remainingIds.slice(insertIndex),
    ];
    return nextIds.length === currentIds.length && nextIds.every((id, index) => id === currentIds[index]);
  }, [orderedClips]);

  const reorderMarkerLeftPx = useMemo(() => {
    if (!clipReorderState) {
      return null;
    }
    const remainingClips = orderedClips.filter((clip) => clip.id !== clipReorderState.clipId);
    const boundarySec = clipReorderState.insertIndex <= 0
      ? 0
      : clipReorderState.insertIndex >= remainingClips.length
        ? virtualDurationSec
        : remainingClips[clipReorderState.insertIndex].timelineStartSec;
    return boundarySec * pxPerSec;
  }, [clipReorderState, orderedClips, pxPerSec, virtualDurationSec]);

  const seekSource = useCallback((virtualSec: number) => {
    const position = locateVirtualPosition(clips, virtualSec);
    if (!position) {
      onSeek(0);
      return;
    }
    onPreviewSource(position.sourceTimeSec, position.clip.assetId);
    onSeek(position.virtualTimeSec);
  }, [clips, onPreviewSource, onSeek]);

  const seekClientX = useCallback((clientX: number) => {
    const virtualSec = sourceSecFromClientX(clientX);
    if (virtualSec === null) {
      return;
    }
    seekSource(virtualSec);
  }, [seekSource, sourceSecFromClientX]);

  const zoomAt = useCallback((nextZoom: number, anchorClientX?: number) => {
    const scrollElement = scrollRef.current;
    const boundedZoom = clamp(nextZoom, 1, MAX_PX_PER_SEC / Math.max(fitPxPerSec, 0.001));
    if (!scrollElement) {
      setZoom(boundedZoom);
      return;
    }
    const rect = scrollElement.getBoundingClientRect();
    const anchorX = anchorClientX === undefined ? rect.left + rect.width / 2 : anchorClientX;
    const sourceAtAnchor = (scrollElement.scrollLeft + anchorX - rect.left) / pxPerSec;
    const nextPxPerSec = clamp(fitPxPerSec * boundedZoom, fitPxPerSec, MAX_PX_PER_SEC);
    setZoom(boundedZoom);
    requestAnimationFrame(() => {
      const nextScrollLeft = Math.max(0, sourceAtAnchor * nextPxPerSec - (anchorX - rect.left));
      scrollElement.scrollLeft = nextScrollLeft;
      setScrollLeftPx(scrollElement.scrollLeft);
    });
  }, [fitPxPerSec, pxPerSec]);

  const setVisibleWindow = useCallback((startSec: number, endSec: number) => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || viewportWidthPx <= 0) {
      return;
    }
    const minVisibleDurationSec = Math.max(MIN_CUT_DURATION_SEC, viewportWidthPx / MAX_PX_PER_SEC);
    const visibleDuration = clamp(endSec - startSec, minVisibleDurationSec, sourceDuration);
    const visibleStart = clamp(startSec, 0, Math.max(0, sourceDuration - visibleDuration));
    const nextPxPerSec = viewportWidthPx / Math.max(visibleDuration, MIN_SOURCE_DURATION_SEC);
    const nextZoom = clamp(nextPxPerSec / Math.max(fitPxPerSec, 0.001), 1, MAX_PX_PER_SEC / Math.max(fitPxPerSec, 0.001));
    setZoom(nextZoom);
    requestAnimationFrame(() => {
      const currentPxPerSec = clamp(fitPxPerSec * nextZoom, fitPxPerSec, MAX_PX_PER_SEC);
      const nextScrollLeft = visibleStart * currentPxPerSec;
      scrollElement.scrollLeft = nextScrollLeft;
      setScrollLeftPx(scrollElement.scrollLeft);
    });
  }, [fitPxPerSec, sourceDuration, viewportWidthPx]);

  const addCut = useCallback((centerSec: number) => {
    if (busy || sourceDuration <= MIN_SOURCE_DURATION_SEC) {
      return;
    }
    const position = locateVirtualPosition(clips, centerSec);
    if (!position || !onAddSkipRange) {
      return;
    }
    const clip = position.clip;
    const sourceStartSec = clamp(position.sourceTimeSec - 0.5, clip.sourceStartSec, Math.max(clip.sourceStartSec, clip.sourceEndSec - MIN_CUT_DURATION_SEC));
    const sourceEndSec = clamp(position.sourceTimeSec + 0.5, sourceStartSec + MIN_CUT_DURATION_SEC, clip.sourceEndSec);
    onAddSkipRange(
      clip.assetId,
      sourceStartSec,
      sourceEndSec,
      `Added skip ${formatSeconds(sourceStartSec)}-${formatSeconds(sourceEndSec)} in ${assetLabelById.get(clip.assetId) ?? clip.assetId}.`,
    );
  }, [assetLabelById, busy, clips, onAddSkipRange, sourceDuration]);

  useEffect(() => {
    if (!pendingCutPlacement) {
      globalThis.document.body.classList.remove('timeline-placing-cut');
      return undefined;
    }
    globalThis.document.body.classList.add('timeline-placing-cut');
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPendingCutPlacement(false);
        setPendingCutPreviewSec(null);
      }
    };
    globalThis.window.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.document.body.classList.remove('timeline-placing-cut');
      globalThis.window.removeEventListener('keydown', handleKeyDown);
    };
  }, [pendingCutPlacement]);

  useEffect(() => {
    if (clips.length === 0 || busy) {
      setPendingCutPlacement(false);
      setPendingCutPreviewSec(null);
    }
  }, [busy, clips.length]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) {
        return;
      }
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) {
        return;
      }
      if (event.key.toLowerCase() === 'c' && selectedClipId) {
        event.preventDefault();
        setCopiedClipId(selectedClipId);
        return;
      }
      if (event.key.toLowerCase() === 'v') {
        const clipId = copiedClipId ?? selectedClipId;
        if (clipId && onDuplicateClip && !busy) {
          event.preventDefault();
          onDuplicateClip(clipId);
        }
      }
    };
    globalThis.window.addEventListener('keydown', handleKeyDown);
    return () => globalThis.window.removeEventListener('keydown', handleKeyDown);
  }, [busy, copiedClipId, onDuplicateClip, selectedClipId]);

  const startResizeSkip = useCallback((skip: TimelineSkipItem, edge: ResizeState['edge'], event: ReactPointerEvent<HTMLElement>) => {
    if (busy || !onUpdateSkipRange || (edge === 'start' && !skip.canResizeStart) || (edge === 'end' && !skip.canResizeEnd)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const id = resizeSequenceRef.current + 1;
    resizeSequenceRef.current = id;
    const initialState: ResizeState = {
      id,
      target: 'skip',
      itemId: skip.skipId,
      edge,
      startClientX: event.clientX,
      startSec: skip.sourceStartSec ?? skip.startSec,
      endSec: skip.sourceEndSec ?? skip.endSec,
      currentStartSec: skip.sourceStartSec ?? skip.startSec,
      currentEndSec: skip.sourceEndSec ?? skip.endSec,
      minStartSec: 0,
      maxEndSec: assetDurationById.get(skip.assetId ?? '') ?? sourceDuration,
      pxPerSec,
    };
    resizeRef.current = initialState;
    setResizeState(initialState);

    const move = (moveEvent: PointerEvent) => {
      const current = resizeRef.current;
      if (!current || current.id !== id) {
        return;
      }
      const deltaSec = (moveEvent.clientX - current.startClientX) / Math.max(current.pxPerSec, 0.001);
      const nextStartSec = current.edge === 'start'
        ? clamp(current.startSec + deltaSec, current.minStartSec, current.currentEndSec - MIN_CUT_DURATION_SEC)
        : current.currentStartSec;
      const nextEndSec = current.edge === 'end'
        ? clamp(current.endSec + deltaSec, nextStartSec + MIN_CUT_DURATION_SEC, current.maxEndSec)
        : current.currentEndSec;
      const nextState = {
        ...current,
        currentStartSec: nextStartSec,
        currentEndSec: nextEndSec,
      };
      resizeRef.current = nextState;
      setResizeState(nextState);
      onPreviewSource(current.edge === 'start' ? nextStartSec : nextEndSec, skip.assetId);
    };
    const end = () => {
      const current = resizeRef.current;
      globalThis.window.removeEventListener('pointermove', move);
      globalThis.window.removeEventListener('pointerup', end);
      globalThis.window.removeEventListener('pointercancel', end);
      if (!current || current.id !== id) {
        resizeRef.current = null;
        setResizeState((state) => (state?.id === id ? null : state));
        return;
      }
      const changed = Math.abs(current.currentStartSec - current.startSec) > 0.001 || Math.abs(current.currentEndSec - current.endSec) > 0.001;
      if (changed) {
        onUpdateSkipRange(
          skip.skipId,
          current.currentStartSec,
          current.currentEndSec,
          `Resized skip ${formatSeconds(current.currentStartSec)}-${formatSeconds(current.currentEndSec)}.`,
        );
      }
      resizeRef.current = null;
      const clearResizeState = () => {
        setResizeState((state) => (state?.id === id ? null : state));
      };
      if (changed) {
        globalThis.window.requestAnimationFrame(clearResizeState);
        return;
      }
      clearResizeState();
    };

    globalThis.window.addEventListener('pointermove', move);
    globalThis.window.addEventListener('pointerup', end, { once: true });
    globalThis.window.addEventListener('pointercancel', end, { once: true });
  }, [assetDurationById, busy, onPreviewSource, onUpdateSkipRange, pxPerSec, sourceDuration]);

  const startClipReorder = useCallback((item: TimelineItem, event: ReactPointerEvent<HTMLElement>) => {
    if (pendingCutPlacement) {
      return;
    }
    if (busy || !onMoveClip || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setSelectedClipId(item.clipId);
    const initialState: ClipReorderState = {
      clipId: item.clipId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      currentClientX: event.clientX,
      currentClientY: event.clientY,
      insertIndex: insertionIndexFromClientX(event.clientX, item.clipId),
      dragging: false,
    };
    clipReorderRef.current = initialState;
    setClipReorderState(initialState);

    const move = (moveEvent: PointerEvent) => {
      const current = clipReorderRef.current;
      if (!current) {
        return;
      }
      const deltaX = moveEvent.clientX - current.startClientX;
      const deltaY = moveEvent.clientY - current.startClientY;
      const dragging = current.dragging || Math.hypot(deltaX, deltaY) >= CLIP_REORDER_THRESHOLD_PX;
      const nextState: ClipReorderState = {
        ...current,
        currentClientX: moveEvent.clientX,
        currentClientY: moveEvent.clientY,
        insertIndex: insertionIndexFromClientX(moveEvent.clientX, current.clipId),
        dragging,
      };
      clipReorderRef.current = nextState;
      setClipReorderState(nextState);
    };
    const end = () => {
      const current = clipReorderRef.current;
      const shouldMove = Boolean(current?.dragging && current && !isReorderNoop(current.clipId, current.insertIndex));
      if (shouldMove && current) {
        onMoveClip(current.clipId, current.insertIndex);
      }
      clipReorderRef.current = null;
      setClipReorderState(null);
      globalThis.window.removeEventListener('pointermove', move);
      globalThis.window.removeEventListener('pointerup', end);
      globalThis.window.removeEventListener('pointercancel', end);
    };

    globalThis.window.addEventListener('pointermove', move);
    globalThis.window.addEventListener('pointerup', end, { once: true });
    globalThis.window.addEventListener('pointercancel', end, { once: true });
  }, [busy, insertionIndexFromClientX, isReorderNoop, onMoveClip, pendingCutPlacement]);

  const startScrub = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.timeline-cut-handle, .timeline-cut-delete, .timeline-skip-delete, .timeline-skip-handle, .timeline-clip-edit-button')) {
      return;
    }
    if (event.button !== 0 || clips.length === 0) {
      return;
    }
    event.preventDefault();
    seekClientX(event.clientX);
    setScrubbing(true);
    globalThis.document.body.classList.add('timeline-scrubbing');

    const move = (moveEvent: PointerEvent) => {
      seekClientX(moveEvent.clientX);
    };
    const end = () => {
      setScrubbing(false);
      globalThis.document.body.classList.remove('timeline-scrubbing');
      globalThis.window.removeEventListener('pointermove', move);
      globalThis.window.removeEventListener('pointerup', end);
      globalThis.window.removeEventListener('pointercancel', end);
    };

    globalThis.window.addEventListener('pointermove', move);
    globalThis.window.addEventListener('pointerup', end, { once: true });
    globalThis.window.addEventListener('pointercancel', end, { once: true });
  }, [clips.length, seekClientX]);

  const startPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (busy || target?.closest('button, .timeline-cut-handle, .timeline-cut-delete, .timeline-skip-delete, .timeline-skip-handle')) {
      return;
    }
    const scrollElement = scrollRef.current;
    if (!scrollElement || scrollElement.scrollWidth <= scrollElement.clientWidth) {
      return;
    }
    event.preventDefault();
    panRef.current = {
      startClientX: event.clientX,
      startScrollLeft: scrollElement.scrollLeft,
    };
    setPanning(true);
    globalThis.document.body.classList.add('timeline-panning');

    const move = (moveEvent: PointerEvent) => {
      const pan = panRef.current;
      if (!pan || !scrollRef.current) {
        return;
      }
      scrollRef.current.scrollLeft = pan.startScrollLeft - (moveEvent.clientX - pan.startClientX);
    };
    const end = () => {
      panRef.current = null;
      setPanning(false);
      globalThis.document.body.classList.remove('timeline-panning');
      globalThis.window.removeEventListener('pointermove', move);
      globalThis.window.removeEventListener('pointerup', end);
      globalThis.window.removeEventListener('pointercancel', end);
    };

    globalThis.window.addEventListener('pointermove', move);
    globalThis.window.addEventListener('pointerup', end, { once: true });
    globalThis.window.addEventListener('pointercancel', end, { once: true });
  }, [busy]);

  const handleTimelinePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (pendingCutPlacement) {
      if (event.button !== 0 || target?.closest('.timeline-cut-handle, .timeline-cut-delete, .timeline-skip-handle, .timeline-skip-delete, button')) {
        return;
      }
      event.preventDefault();
      const sourceSec = sourceSecFromClientX(event.clientX);
      if (sourceSec === null) {
        return;
      }
      addCut(sourceSec);
      setPendingCutPlacement(false);
      setPendingCutPreviewSec(null);
      return;
    }
    if (event.altKey || event.button === 1) {
      startPan(event);
      return;
    }
    startScrub(event);
  }, [addCut, pendingCutPlacement, sourceSecFromClientX, startPan, startScrub]);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }
    event.preventDefault();
    const direction = event.deltaY > 0 ? -1 : 1;
    zoomAt(zoom * (direction > 0 ? 1.18 : 1 / 1.18), event.clientX);
  }, [zoom, zoomAt]);

  const handleTimelineScroll = useCallback(() => {
    setScrollLeftPx(scrollRef.current?.scrollLeft ?? 0);
  }, []);

  const handleViewportPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pendingCutPlacement) {
      return;
    }
    setPendingCutPreviewSec(sourceSecFromClientX(event.clientX));
  }, [pendingCutPlacement, sourceSecFromClientX]);

  const handleViewportPointerLeave = useCallback(() => {
    if (!pendingCutPlacement) {
      return;
    }
    setPendingCutPreviewSec(null);
  }, [pendingCutPlacement]);

  const handleDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const assetId = event.dataTransfer.getData('application/x-axcut-asset');
    if (!assetId || !onAssetDrop) {
      return;
    }
    event.preventDefault();
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }
    const rect = scrollElement.getBoundingClientRect();
    const timelineSec = (scrollElement.scrollLeft + event.clientX - rect.left) / Math.max(pxPerSec, 0.001);
    onAssetDrop({
      assetId,
      insertAtSec: clamp(timelineSec, 0, Math.max(sourceDuration, virtualDurationSec)),
    });
  }, [onAssetDrop, pxPerSec, sourceDuration, virtualDurationSec]);

  const startNavigatorDrag = useCallback((mode: NavigatorDragState['mode'], event: ReactPointerEvent<HTMLElement>) => {
    if (busy || clips.length === 0) {
      return;
    }
    const overview = overviewRef.current;
    if (!overview) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const nextState: NavigatorDragState = {
      mode,
      startClientX: event.clientX,
      overviewWidthPx: Math.max(1, overview.clientWidth),
      startVisibleStartSec: visibleStartSec,
      startVisibleEndSec: visibleEndSec,
    };
    navigatorDragRef.current = nextState;
    setNavigatorDragging(true);
    globalThis.document.body.classList.add('timeline-navigating');

    const move = (moveEvent: PointerEvent) => {
      const current = navigatorDragRef.current;
      if (!current) {
        return;
      }
      const deltaSec = ((moveEvent.clientX - current.startClientX) / current.overviewWidthPx) * sourceDuration;
      const currentDuration = current.startVisibleEndSec - current.startVisibleStartSec;
      if (current.mode === 'move') {
        const nextStartSec = clamp(current.startVisibleStartSec + deltaSec, 0, Math.max(0, sourceDuration - currentDuration));
        setVisibleWindow(nextStartSec, nextStartSec + currentDuration);
        return;
      }
      if (current.mode === 'start') {
        const nextStartSec = clamp(current.startVisibleStartSec + deltaSec, 0, current.startVisibleEndSec - MIN_CUT_DURATION_SEC);
        setVisibleWindow(nextStartSec, current.startVisibleEndSec);
        return;
      }
      const nextEndSec = clamp(current.startVisibleEndSec + deltaSec, current.startVisibleStartSec + MIN_CUT_DURATION_SEC, sourceDuration);
      setVisibleWindow(current.startVisibleStartSec, nextEndSec);
    };
    const end = () => {
      navigatorDragRef.current = null;
      setNavigatorDragging(false);
      globalThis.document.body.classList.remove('timeline-navigating');
      globalThis.window.removeEventListener('pointermove', move);
      globalThis.window.removeEventListener('pointerup', end);
      globalThis.window.removeEventListener('pointercancel', end);
    };

    globalThis.window.addEventListener('pointermove', move);
    globalThis.window.addEventListener('pointerup', end, { once: true });
    globalThis.window.addEventListener('pointercancel', end, { once: true });
  }, [busy, clips.length, setVisibleWindow, sourceDuration, visibleEndSec, visibleStartSec]);

  return (
    <>
    <section className="timeline-pane panel">
      <div className="timeline-header">
        <div>
          <h2>Timeline</h2>
          <span className="sr-only">{assetCount} timeline sources</span>
          <p className="muted">
            {clips.length} clip{clips.length === 1 ? '' : 's'} · {skipItems.length} skip{skipItems.length === 1 ? '' : 's'} · {formatSeconds(virtualDurationSec)} total
          </p>
        </div>
        <div className="timeline-readout">
          <button
            className={pendingCutPlacement ? 'timeline-tool secondary icon-only active' : 'timeline-tool secondary icon-only'}
            type="button"
            onClick={() => {
              setPendingCutPlacement((active) => {
                if (active) {
                  setPendingCutPreviewSec(null);
                  return false;
                }
                const centerSec = activePosition?.virtualTimeSec ?? clips[0]?.timelineStartSec ?? 0;
                setPendingCutPreviewSec(centerSec);
                return true;
              });
            }}
            disabled={busy || clips.length === 0}
            title={pendingCutPlacement ? 'Click on the timeline to place the skip' : 'Place skip'}
            aria-pressed={pendingCutPlacement}
          >
            <Scissors size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="sr-only">{pendingCutPlacement ? 'Click on the timeline to place the skip' : 'Place skip'}</span>
          </button>
          <strong>{formatSeconds(currentTimeSec)}</strong>
          <span className="muted">{pendingCutPlacement ? 'Click on the timeline to place the skip' : activePosition ? `Clip ${activePosition.clipIndex + 1}/${clips.length}` : 'No active clip'}</span>
        </div>
      </div>

      <div className="timeline-navigator-row">
        <div
          ref={overviewRef}
          className={navigatorDragging ? 'timeline-navigator navigating' : 'timeline-navigator'}
          aria-label="Timeline zoom and pan navigator"
        >
          <div className="timeline-navigator-content">
            {skipItems.map((skip) => (
              <span
                key={`${skip.skipId}:${skip.id}:navigator`}
                className="timeline-navigator-skip"
                style={{
                  left: `${(skip.startSec / Math.max(sourceDuration, MIN_SOURCE_DURATION_SEC)) * 100}%`,
                  width: `${((skip.endSec - skip.startSec) / Math.max(sourceDuration, MIN_SOURCE_DURATION_SEC)) * 100}%`,
                }}
              />
            ))}
          </div>
          <div className="timeline-navigator-window" style={navigatorWindowStyle} onPointerDown={(event) => startNavigatorDrag('move', event)}>
            <span className="timeline-navigator-handle start" onPointerDown={(event) => startNavigatorDrag('start', event)} />
            <span className="timeline-navigator-handle end" onPointerDown={(event) => startNavigatorDrag('end', event)} />
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className={[
          'timeline-viewport',
          pendingCutPlacement ? 'placing-cut' : '',
          panning ? 'panning' : '',
          scrubbing ? 'scrubbing' : '',
        ].filter(Boolean).join(' ')}
        onPointerDown={handleTimelinePointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerLeave={handleViewportPointerLeave}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('application/x-axcut-asset')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={handleDrop}
        onWheel={handleWheel}
        onScroll={handleTimelineScroll}
        aria-label="Source timeline. Click or drag to scrub, use the navigator or Alt drag to pan, and Ctrl wheel to zoom."
      >
        {clips.length > 0 ? (
          <div className="timeline-canvas" style={{ width: `${contentWidthPx}px` }}>
            <div className="timeline-ruler" style={{ height: `${RULER_HEIGHT_PX}px` }}>
              {rulerTicks.map((tick) => (
                <div
                  key={`${tick.timeSec}-${tick.major ? 'major' : 'minor'}`}
                  className={tick.major ? 'timeline-tick major' : 'timeline-tick'}
                  style={{ left: `${tick.timeSec * pxPerSec}px` }}
                >
                  {tick.major ? <span>{formatSeconds(tick.timeSec)}</span> : null}
                </div>
              ))}
            </div>
            <div className="timeline-track-lane">
              {clips.map((clip) => {
                const editing = clipEditId === clip.id;
                const selected = selectedClipId === clip.id;
                const reordering = clipReorderState?.clipId === clip.id && clipReorderState.dragging;
                return (
                  <Fragment key={`${clip.id}:frame`}>
                    <button
                      className={editing ? 'timeline-clip-edit-button active' : 'timeline-clip-edit-button'}
                      type="button"
                      style={{
                        left: `${clip.timelineStartSec * pxPerSec}px`,
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedClipId(clip.id);
                        setClipEditId(clip.id);
                      }}
                      disabled={busy}
                      title="Edit clip source range"
                      aria-pressed={editing}
                      aria-label="Edit clip source range"
                    >
                      <Pencil size={12} strokeWidth={1.9} aria-hidden="true" />
                    </button>
                    <div
                      className={[
                        'timeline-clip-frame',
                        selected ? 'selected' : '',
                        editing ? 'editing' : '',
                        reordering ? 'reordering' : '',
                      ].filter(Boolean).join(' ')}
                      style={{
                        left: `${clip.timelineStartSec * pxPerSec}px`,
                        width: `${Math.max(MIN_SEGMENT_WIDTH_PX, (clip.timelineEndSec - clip.timelineStartSec) * pxPerSec)}px`,
                      }}
                    />
                  </Fragment>
                );
              })}
              {timelineItems.map((item) => {
                const style = timelineItemStyle(item, pxPerSec);
                if (item.kind === 'skip') {
                  const active = resizeState?.target === 'skip' && resizeState.itemId === item.skipId;
                  const compact = (item.endSec - item.startSec) * pxPerSec < 18;
                  const itemClip = clipById.get(item.clipId);
                  const edgeStart = itemClip ? Math.abs(item.startSec - itemClip.timelineStartSec) < 0.001 : false;
                  const edgeEnd = itemClip ? Math.abs(item.endSec - itemClip.timelineEndSec) < 0.001 : false;
                  return (
                    <div
                      key={item.id}
                      className={[
                        'timeline-segment',
                        'timeline-skip',
                        active ? 'active' : '',
                        compact ? 'compact' : '',
                        edgeStart ? 'clip-edge-start' : '',
                        edgeEnd ? 'clip-edge-end' : '',
                      ].filter(Boolean).join(' ')}
                      style={style}
                      title={`Skip ${item.label ?? 'source'} ${formatSeconds(item.sourceStartSec ?? item.startSec)}-${formatSeconds(item.sourceEndSec ?? item.endSec)}${item.reason ? ` · ${item.reason}` : ''}`}
                      onPointerDown={(event) => {
                        startClipReorder(item, event);
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedClipId(item.clipId);
                      }}
                    >
                      {item.canResizeStart ? (
                        <button
                          className="timeline-skip-handle start"
                          type="button"
                          onPointerDown={(event) => startResizeSkip(item, 'start', event)}
                          disabled={busy || !onUpdateSkipRange}
                          aria-label={`Adjust skip start at ${formatSeconds(item.sourceStartSec ?? item.startSec)}`}
                          title="Adjust skip start"
                        />
                      ) : null}
                      <div className="timeline-segment-label">
                        <span>Skip</span>
                        <small>{formatSeconds(item.startSec)}-{formatSeconds(item.endSec)}</small>
                      </div>
                      <button
                        className="timeline-skip-delete"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRemoveSkipRange?.(item.skipId);
                        }}
                        disabled={busy || !onRemoveSkipRange}
                        title="Remove skip"
                        aria-label={`Remove skip ${formatSeconds(item.startSec)}-${formatSeconds(item.endSec)}`}
                      >
                        <Trash2 size={12} strokeWidth={1.9} aria-hidden="true" />
                      </button>
                      {item.canResizeEnd ? (
                        <button
                          className="timeline-skip-handle end"
                          type="button"
                          onPointerDown={(event) => startResizeSkip(item, 'end', event)}
                          disabled={busy || !onUpdateSkipRange}
                          aria-label={`Adjust skip end at ${formatSeconds(item.sourceEndSec ?? item.endSec)}`}
                          title="Adjust skip end"
                        />
                      ) : null}
                    </div>
                  );
                }
                const active = playheadSourceSec !== null && playheadSourceSec >= item.startSec && playheadSourceSec <= item.endSec;
                const selected = selectedClipId === item.clipId;
                const reordering = clipReorderState?.clipId === item.clipId && clipReorderState.dragging;
                const itemClip = clipById.get(item.clipId);
                const edgeStart = itemClip ? Math.abs(item.startSec - itemClip.timelineStartSec) < 0.001 : false;
                const edgeEnd = itemClip ? Math.abs(item.endSec - itemClip.timelineEndSec) < 0.001 : false;
                return (
                  <div
                    key={item.id}
                    className={[
                      'timeline-segment',
                      'timeline-kept',
                      active ? 'active' : '',
                      selected ? 'selected' : '',
                      reordering ? 'reordering' : '',
                      edgeStart ? 'clip-edge-start' : '',
                      edgeEnd ? 'clip-edge-end' : '',
                    ].filter(Boolean).join(' ')}
                    style={style}
                    title={`${item.label ?? 'Clip'} · timeline ${formatSeconds(item.startSec)}-${formatSeconds(item.endSec)}`}
                    onPointerDown={(event) => {
                      startClipReorder(item, event);
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedClipId(item.clipId);
                    }}
                  >
                    <div className="timeline-segment-label">
                      <span>{item.label ?? 'Clip'}</span>
                      <small>
                        {formatSeconds(item.startSec)}-{formatSeconds(item.endSec)}
                        {item.sourceStartSec !== undefined && item.sourceEndSec !== undefined
                          ? ` · source ${formatSeconds(item.sourceStartSec)}-${formatSeconds(item.sourceEndSec)}`
                        : ''}
                      </small>
                    </div>
                  </div>
                );
              })}
              {playheadSourceSec !== null ? (
                <div className="timeline-playhead" style={{ left: `${playheadSourceSec * pxPerSec}px` }} aria-hidden="true" />
              ) : null}
              {pendingCutPlacement && pendingCutPreviewSec !== null ? (
                <div className="timeline-placement-marker" style={{ left: `${pendingCutPreviewSec * pxPerSec}px` }} aria-hidden="true" />
              ) : null}
              {clipReorderState?.dragging && reorderMarkerLeftPx !== null ? (
                <div className="timeline-reorder-marker" style={{ left: `${reorderMarkerLeftPx}px` }} aria-hidden="true" />
              ) : null}
            </div>
          </div>
        ) : (
          <div className="timeline-empty muted">No virtual clips yet.</div>
        )}
      </div>
    </section>
    {clipEditClip ? (
      <ClipEditDialog
        clip={clipEditClip}
        asset={assets.find((asset) => asset.id === clipEditClip.assetId) ?? null}
        videoSources={videoSources}
        revision={previewRevision}
        busy={busy}
        onClose={() => setClipEditId(null)}
        onUpdateClipRange={onUpdateClipRange}
      />
    ) : null}
    </>
  );
}

type ClipEditDragState = {
  edge: 'start' | 'end';
  startClientX: number;
  startSec: number;
  endSec: number;
  widthPx: number;
  durationSec: number;
};

type ClipEditDialogProps = {
  clip: AxcutClip;
  asset: AxcutAsset | null;
  videoSources: VideoSource[];
  revision: number;
  busy: boolean;
  onClose: () => void;
  onUpdateClipRange?: (clipId: string, sourceStartSec: number, sourceEndSec: number, reason: string) => void;
};

function ClipEditDialog({
  clip,
  asset,
  videoSources,
  revision,
  busy,
  onClose,
  onUpdateClipRange,
}: ClipEditDialogProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<ClipEditDragState | null>(null);
  const [draftStartSec, setDraftStartSec] = useState(clip.sourceStartSec);
  const [draftEndSec, setDraftEndSec] = useState(clip.sourceEndSec);
  const [activeEdge, setActiveEdge] = useState<ClipEditDragState['edge'] | null>(null);
  const sourceDurationSec = Math.max(asset?.durationSec ?? clip.sourceEndSec, clip.sourceEndSec, MIN_SOURCE_DURATION_SEC);
  const clipDurationSec = Math.max(MIN_SOURCE_DURATION_SEC, draftEndSec - draftStartSec);
  const hasChanges = Math.abs(draftStartSec - clip.sourceStartSec) > 0.001 || Math.abs(draftEndSec - clip.sourceEndSec) > 0.001;
  const clipSources = useMemo(
    () => videoSources.filter((source) => source.assetId === clip.assetId),
    [clip.assetId, videoSources],
  );
  const previewClip = useMemo<AxcutClip>(() => ({
    ...clip,
    id: `${clip.id}:clip-edit-preview`,
    sourceStartSec: draftStartSec,
    sourceEndSec: draftEndSec,
    timelineStartSec: 0,
    timelineEndSec: clipDurationSec,
  }), [clip, clipDurationSec, draftEndSec, draftStartSec]);
  const rangeStyle = useMemo(() => ({
    left: `${(draftStartSec / sourceDurationSec) * 100}%`,
    width: `${Math.max(0.2, ((draftEndSec - draftStartSec) / sourceDurationSec) * 100)}%`,
  }) as CSSProperties, [draftEndSec, draftStartSec, sourceDurationSec]);

  useEffect(() => {
    setDraftStartSec(clip.sourceStartSec);
    setDraftEndSec(clip.sourceEndSec);
    dragRef.current = null;
    setActiveEdge(null);
  }, [clip.id, clip.sourceEndSec, clip.sourceStartSec]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    globalThis.window.addEventListener('keydown', handleKeyDown);
    return () => globalThis.window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const startDrag = useCallback((edge: ClipEditDragState['edge'], event: ReactPointerEvent<HTMLButtonElement>) => {
    if (busy) {
      return;
    }
    const track = trackRef.current;
    if (!track) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      edge,
      startClientX: event.clientX,
      startSec: draftStartSec,
      endSec: draftEndSec,
      widthPx: Math.max(1, track.clientWidth),
      durationSec: sourceDurationSec,
    };
    setActiveEdge(edge);

    const move = (moveEvent: PointerEvent) => {
      const current = dragRef.current;
      if (!current) {
        return;
      }
      const deltaSec = ((moveEvent.clientX - current.startClientX) / current.widthPx) * current.durationSec;
      if (current.edge === 'start') {
        setDraftStartSec(clamp(current.startSec + deltaSec, 0, current.endSec - MIN_CUT_DURATION_SEC));
        return;
      }
      setDraftEndSec(clamp(current.endSec + deltaSec, current.startSec + MIN_CUT_DURATION_SEC, current.durationSec));
    };
    const end = () => {
      dragRef.current = null;
      setActiveEdge(null);
      globalThis.window.removeEventListener('pointermove', move);
      globalThis.window.removeEventListener('pointerup', end);
      globalThis.window.removeEventListener('pointercancel', end);
    };

    globalThis.window.addEventListener('pointermove', move);
    globalThis.window.addEventListener('pointerup', end, { once: true });
    globalThis.window.addEventListener('pointercancel', end, { once: true });
  }, [busy, draftEndSec, draftStartSec, sourceDurationSec]);

  const applyChanges = useCallback(() => {
    if (busy || !onUpdateClipRange || !hasChanges) {
      return;
    }
    onUpdateClipRange(
      clip.id,
      draftStartSec,
      draftEndSec,
      `Changed clip ${clip.id} source range to ${formatSeconds(draftStartSec)}-${formatSeconds(draftEndSec)}.`,
    );
    onClose();
  }, [busy, clip.id, draftEndSec, draftStartSec, hasChanges, onClose, onUpdateClipRange]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <section className="modal panel clip-edit-modal" role="dialog" aria-modal="true" aria-label="Edit clip">
        <header className="modal-header">
          <div className="modal-title-row">
            <div>
              <h2>Edit clip</h2>
              <p className="muted">{asset?.label ?? clip.assetId}</p>
            </div>
          </div>
          <button className="icon-action secondary" type="button" onClick={onClose} aria-label="Close clip editor" title="Close clip editor">
            <X size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </header>

        <div className="clip-edit-body">
          <div className="clip-edit-preview">
            <VirtualPreview
              videoSources={clipSources}
              clips={[previewClip]}
              revision={revision}
            />
          </div>

          <div className="clip-edit-sidebar">
            <div className="clip-edit-range-readout">
              <span>
                <strong>{formatSeconds(draftStartSec)}</strong>
                <small className="muted">Start</small>
              </span>
              <span>
                <strong>{formatSeconds(draftEndSec)}</strong>
                <small className="muted">End</small>
              </span>
              <span>
                <strong>{formatSeconds(clipDurationSec)}</strong>
                <small className="muted">Duration</small>
              </span>
            </div>

            <div className="clip-edit-source-timeline" aria-label="Clip source range editor">
              <div className="clip-edit-timeline-labels">
                <span>0:00.0</span>
                <span>{formatSeconds(sourceDurationSec)}</span>
              </div>
              <div className="clip-edit-track" ref={trackRef}>
                <div className="clip-edit-muted-range before" style={{ width: `${(draftStartSec / sourceDurationSec) * 100}%` }} />
                <div
                  className={[
                    'clip-edit-selected-range',
                    activeEdge ? 'dragging' : '',
                  ].filter(Boolean).join(' ')}
                  style={rangeStyle}
                >
                  <button
                    className={activeEdge === 'start' ? 'clip-edit-handle start active' : 'clip-edit-handle start'}
                    type="button"
                    onPointerDown={(event) => startDrag('start', event)}
                    disabled={busy}
                    aria-label="Adjust clip start"
                    title="Adjust clip start"
                  />
                  <span>{formatSeconds(draftStartSec)}-{formatSeconds(draftEndSec)}</span>
                  <button
                    className={activeEdge === 'end' ? 'clip-edit-handle end active' : 'clip-edit-handle end'}
                    type="button"
                    onPointerDown={(event) => startDrag('end', event)}
                    disabled={busy}
                    aria-label="Adjust clip end"
                    title="Adjust clip end"
                  />
                </div>
                <div className="clip-edit-muted-range after" style={{ left: `${(draftEndSec / sourceDurationSec) * 100}%`, width: `${Math.max(0, ((sourceDurationSec - draftEndSec) / sourceDurationSec) * 100)}%` }} />
              </div>
            </div>

            <div className="clip-edit-actions">
              <button className="secondary" type="button" onClick={() => {
                setDraftStartSec(clip.sourceStartSec);
                setDraftEndSec(clip.sourceEndSec);
              }} disabled={busy || !hasChanges}>
                Reset
              </button>
              <button className="secondary" type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" onClick={applyChanges} disabled={busy || !hasChanges || !onUpdateClipRange}>
                Apply
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function buildTimelineSkipItems(
  clips: AxcutClip[],
  skipRanges: AxcutTimeline['skipRanges'],
  assetLabelById: Map<string, string>,
  durationSec: number,
  resizeState: ResizeState | null,
): TimelineSkipItem[] {
  return buildTimelineItems(clips, skipRanges, assetLabelById, durationSec, resizeState)
    .filter((item): item is TimelineSkipItem => item.kind === 'skip');
}

function buildTimelineItems(
  clips: AxcutClip[],
  skipRanges: AxcutTimeline['skipRanges'],
  assetLabelById: Map<string, string>,
  durationSec: number,
  resizeState: ResizeState | null,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const visibleClips = clips.map((clip) => {
    if (resizeState?.target !== 'clip' || resizeState.itemId !== clip.id) {
      return clip;
    }
    return {
      ...clip,
      sourceStartSec: resizeState.currentStartSec,
      sourceEndSec: resizeState.currentEndSec,
      timelineEndSec: clip.timelineStartSec + Math.max(0, resizeState.currentEndSec - resizeState.currentStartSec),
    };
  });

  for (const clip of visibleClips) {
    const label = assetLabelById.get(clip.assetId) ?? clip.assetId;
    const visibleSkips = skipRanges
      .filter((skip) => skip.assetId === clip.assetId)
      .map((skip) => resizeState?.target === 'skip' && resizeState.itemId === skip.id
        ? { ...skip, startSec: resizeState.currentStartSec, endSec: resizeState.currentEndSec }
        : skip)
      .filter((skip) => skip.endSec > clip.sourceStartSec && skip.startSec < clip.sourceEndSec)
      .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
    let cursorSourceSec = clip.sourceStartSec;
    let partIndex = 1;

    const pushKept = (sourceStartSec: number, sourceEndSec: number) => {
      if (sourceEndSec <= sourceStartSec) {
        return;
      }
      const startSec = clamp(clip.timelineStartSec + sourceStartSec - clip.sourceStartSec, 0, durationSec);
      const endSec = clamp(clip.timelineStartSec + sourceEndSec - clip.sourceStartSec, 0, durationSec);
      if (endSec <= startSec) {
        return;
      }
      items.push({
        kind: 'kept',
        id: `${clip.id}:kept:${partIndex}`,
        clipId: clip.id,
        assetId: clip.assetId,
        startSec,
        endSec,
        sourceStartSec,
        sourceEndSec,
        label,
        canResizeClipStart: Math.abs(sourceStartSec - clip.sourceStartSec) < 0.001,
        canResizeClipEnd: Math.abs(sourceEndSec - clip.sourceEndSec) < 0.001,
      });
      partIndex += 1;
    };

    for (const skip of visibleSkips) {
      const sourceStartSec = Math.max(clip.sourceStartSec, skip.startSec, cursorSourceSec);
      const sourceEndSec = Math.min(clip.sourceEndSec, skip.endSec);
      pushKept(cursorSourceSec, sourceStartSec);
      const startSec = clamp(clip.timelineStartSec + sourceStartSec - clip.sourceStartSec, 0, durationSec);
      const endSec = clamp(clip.timelineStartSec + sourceEndSec - clip.sourceStartSec, 0, durationSec);
      if (endSec > startSec) {
        items.push({
          kind: 'skip',
          id: `${clip.id}:skip:${skip.id}`,
          clipId: clip.id,
          skipId: skip.id,
          assetId: skip.assetId,
          startSec,
          endSec,
          sourceStartSec,
          sourceEndSec,
          label,
          reason: skip.reason,
          canResizeStart: Math.abs(sourceStartSec - skip.startSec) < 0.001,
          canResizeEnd: Math.abs(sourceEndSec - skip.endSec) < 0.001,
        });
      }
      cursorSourceSec = Math.max(cursorSourceSec, sourceEndSec);
    }

    pushKept(cursorSourceSec, clip.sourceEndSec);
  }

  return items.sort((a, b) => a.startSec - b.startSec || (a.kind === 'kept' ? -1 : 1));
}

function timelineItemStyle(item: { startSec: number; endSec: number }, pxPerSec: number): CSSProperties {
  return {
    left: `${item.startSec * pxPerSec}px`,
    width: `${Math.max(MIN_SEGMENT_WIDTH_PX, (item.endSec - item.startSec) * pxPerSec)}px`,
    minWidth: `${MIN_SEGMENT_WIDTH_PX}px`,
  };
}

function buildRulerTicks(durationSec: number, pxPerSec: number): Array<{ timeSec: number; major: boolean }> {
  const majorStepSec = chooseTickStep(90 / Math.max(pxPerSec, 0.001));
  const minorStepSec = majorStepSec / 5;
  const ticks: Array<{ timeSec: number; major: boolean }> = [];
  for (let timeSec = 0; timeSec <= durationSec + minorStepSec / 2; timeSec += minorStepSec) {
    const rounded = Number(timeSec.toFixed(4));
    const major = Math.abs(rounded / majorStepSec - Math.round(rounded / majorStepSec)) < 0.001;
    ticks.push({ timeSec: Math.min(durationSec, rounded), major });
  }
  return ticks;
}

function chooseTickStep(minStepSec: number): number {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((step) => step >= minStepSec) ?? steps.at(-1)!;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
