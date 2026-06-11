import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { AxcutClip } from '@axcut/schema';

import { formatSeconds, locateVirtualPosition, totalVirtualDuration } from '../lib/virtual-preview.js';

type SourceRange = {
  id: string;
  startSec: number;
  endSec: number;
};

type TimelinePaneProps = {
  clips: AxcutClip[];
  currentTimeSec: number;
  sourceDurationSec: number;
  busy?: boolean;
  onSeek: (timeSec: number) => void;
  onPreviewSource: (sourceTimeSec: number) => void;
  onReplaceTimeline: (intervals: Array<{ startSec: number; endSec: number }>, reason: string) => void;
};

type CutDragState = {
  id: number;
  cut: SourceRange;
  baseCutRanges: SourceRange[];
  edge: 'start' | 'end';
  startClientX: number;
  originalStartSec: number;
  originalEndSec: number;
  currentStartSec: number;
  currentEndSec: number;
  secondsPerPixel: number;
  sourceDuration: number;
};

const MIN_CUT_DURATION_SEC = 0.1;
const SEGMENT_MIN_WIDTH_PX = 42;
const CUT_EDGE_HIT_ZONE_PX = 18;

type TimelineItem =
  | { type: 'clip'; startSec: number; endSec: number; range: SourceRange }
  | { type: 'cut'; startSec: number; endSec: number; range: SourceRange };

export function TimelinePane({ clips, currentTimeSec, sourceDurationSec, busy = false, onSeek, onPreviewSource, onReplaceTimeline }: TimelinePaneProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragSequenceRef = useRef(0);
  const committedDragRef = useRef<number | null>(null);
  const dragStateRef = useRef<CutDragState | null>(null);
  const activeDragCleanupRef = useRef<(() => void) | null>(null);
  const callbacksRef = useRef({ onSeek, onPreviewSource, onReplaceTimeline });
  const suppressNextClipClickRef = useRef(false);
  const [trackWidthPx, setTrackWidthPx] = useState(0);
  const durationSec = totalVirtualDuration(clips);
  const activePosition = locateVirtualPosition(clips, currentTimeSec);
  const sourceDuration = useMemo(() => Math.max(sourceDurationSec, ...clips.map((clip) => clip.sourceEndSec), 0), [clips, sourceDurationSec]);
  const keptIntervals = useMemo(() => normalizeSourceRanges(sourceDuration, clips.map((clip) => ({ startSec: clip.sourceStartSec, endSec: clip.sourceEndSec }))), [clips, sourceDuration]);
  const cutRanges = useMemo(() => deriveCutRanges(keptIntervals, sourceDuration), [keptIntervals, sourceDuration]);
  const [dragState, setDragState] = useState<CutDragState | null>(null);
  const trackTotal = Math.max(sourceDuration, durationSec, 0.001);
  const visibleCutRanges = useMemo(() => {
    if (!dragState) {
      return cutRanges;
    }
    return normalizeSourceRanges(sourceDuration, cutRanges.map((cut) => cut.id === dragState.cut.id
      ? { ...cut, startSec: dragState.currentStartSec, endSec: dragState.currentEndSec }
      : cut));
  }, [cutRanges, dragState, sourceDuration]);
  const visibleKeptIntervals = useMemo(() => normalizeSourceRanges(sourceDuration, invertCutRanges(visibleCutRanges, sourceDuration)), [sourceDuration, visibleCutRanges]);
  const timelineItems = useMemo(() => buildTimelineItems(visibleKeptIntervals, visibleCutRanges), [visibleKeptIntervals, visibleCutRanges]);

  useEffect(() => {
    callbacksRef.current = { onSeek, onPreviewSource, onReplaceTimeline };
  }, [onPreviewSource, onReplaceTimeline, onSeek]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) {
      return;
    }
    const updateTrackWidth = () => setTrackWidthPx(track.clientWidth);
    updateTrackWidth();
    const observer = new ResizeObserver(updateTrackWidth);
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => activeDragCleanupRef.current?.();
  }, []);

  const startCutResize = (
    cut: SourceRange,
    edge: 'start' | 'end',
    event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>,
  ) => {
    if (busy) {
      return;
    }
    if (dragStateRef.current) {
      return;
    }
    const track = trackRef.current;
    if (!track) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const pointerId = 'pointerId' in event ? event.pointerId : undefined;
    if (pointerId !== undefined && 'setPointerCapture' in event.currentTarget) {
      try {
        event.currentTarget.setPointerCapture(pointerId);
      } catch {
        // The browser can reject capture if the pointer is already released.
      }
    }
    activeDragCleanupRef.current?.();
    onPreviewSource(edge === 'start' ? cut.startSec : cut.endSec);
    const dragId = dragSequenceRef.current + 1;
    dragSequenceRef.current = dragId;
    committedDragRef.current = null;
    const initialState: CutDragState = {
      id: dragId,
      cut,
      baseCutRanges: cutRanges,
      edge,
      startClientX: event.clientX,
      originalStartSec: cut.startSec,
      originalEndSec: cut.endSec,
      currentStartSec: cut.startSec,
      currentEndSec: cut.endSec,
      secondsPerPixel: trackTotal / Math.max(1, track.clientWidth),
      sourceDuration,
    };
    dragStateRef.current = initialState;
    setDragState(initialState);

    const updateDrag = (clientX: number) => {
      const current = dragStateRef.current;
      if (!current) {
        return;
      }
      const deltaSec = (clientX - current.startClientX) * current.secondsPerPixel;
      const nextState = current.edge === 'start'
        ? { ...current, currentStartSec: clamp(current.originalStartSec + deltaSec, 0, current.currentEndSec - MIN_CUT_DURATION_SEC) }
        : { ...current, currentEndSec: clamp(current.originalEndSec + deltaSec, current.currentStartSec + MIN_CUT_DURATION_SEC, current.sourceDuration) };
      dragStateRef.current = nextState;
      setDragState(nextState);
      const nextCuts = normalizeSourceRanges(current.sourceDuration, [
        ...current.baseCutRanges.filter((item) => item.id !== nextState.cut.id),
        { id: nextState.cut.id, startSec: nextState.currentStartSec, endSec: nextState.currentEndSec },
      ]);
      const nextIntervals = invertCutRanges(nextCuts, current.sourceDuration);
      const boundarySourceSec = nextState.edge === 'start' ? nextState.currentStartSec : nextState.currentEndSec;
      callbacksRef.current.onPreviewSource(boundarySourceSec);
      callbacksRef.current.onSeek(sourceToVirtualTime(nextIntervals, boundarySourceSec));
    };

    const handlePointerMove = (moveEvent: PointerEvent) => updateDrag(moveEvent.clientX);
    const handleMouseMove = (moveEvent: MouseEvent) => updateDrag(moveEvent.clientX);

    const endDrag = () => {
      const current = dragStateRef.current;
      if (current && committedDragRef.current !== current.id) {
        committedDragRef.current = current.id;
        commitCutChange(
          current.baseCutRanges,
          current.sourceDuration,
          current.cut,
          { startSec: current.currentStartSec, endSec: current.currentEndSec },
          callbacksRef.current.onReplaceTimeline,
        );
      }
      dragStateRef.current = null;
      setDragState(null);
      activeDragCleanupRef.current?.();
    };

    const cleanup = () => {
      globalThis.document.body.classList.remove('resizing-cut');
      globalThis.window.removeEventListener('pointermove', handlePointerMove);
      globalThis.window.removeEventListener('pointerup', endDrag);
      globalThis.window.removeEventListener('pointercancel', endDrag);
      globalThis.window.removeEventListener('mousemove', handleMouseMove);
      globalThis.window.removeEventListener('mouseup', endDrag);
      globalThis.document.removeEventListener('mouseup', endDrag);
      activeDragCleanupRef.current = null;
    };
    activeDragCleanupRef.current = cleanup;
    globalThis.document.body.classList.add('resizing-cut');
    globalThis.window.addEventListener('pointermove', handlePointerMove);
    globalThis.window.addEventListener('pointerup', endDrag, { once: true });
    globalThis.window.addEventListener('pointercancel', endDrag, { once: true });
    globalThis.window.addEventListener('mousemove', handleMouseMove);
    globalThis.window.addEventListener('mouseup', endDrag, { once: true });
    globalThis.document.addEventListener('mouseup', endDrag, { once: true });
  };

  const startCutResizeFromEdge = (cut: SourceRange, event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.cut-delete, .cut-resize-handle')) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const distanceFromLeft = event.clientX - rect.left;
    const distanceFromRight = rect.right - event.clientX;
    if (distanceFromLeft <= CUT_EDGE_HIT_ZONE_PX) {
      startCutResize(cut, 'start', event);
      return;
    }
    if (distanceFromRight <= CUT_EDGE_HIT_ZONE_PX) {
      startCutResize(cut, 'end', event);
    }
  };

  const startClipBoundaryResize = (
    previousItem: TimelineItem | undefined,
    nextItem: TimelineItem | undefined,
    event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const distanceFromLeft = event.clientX - rect.left;
    const distanceFromRight = rect.right - event.clientX;
    if (distanceFromLeft <= CUT_EDGE_HIT_ZONE_PX && previousItem?.type === 'cut') {
      suppressNextClipClickRef.current = true;
      startCutResize(previousItem.range, 'end', event);
      return;
    }
    if (distanceFromRight <= CUT_EDGE_HIT_ZONE_PX && nextItem?.type === 'cut') {
      suppressNextClipClickRef.current = true;
      startCutResize(nextItem.range, 'start', event);
    }
  };

  const deleteCut = (cut: SourceRange) => {
    if (busy) {
      return;
    }
    const nextCuts = cutRanges.filter((item) => item.id !== cut.id);
    const nextIntervals = invertCutRanges(normalizeSourceRanges(sourceDuration, nextCuts), sourceDuration);
    onReplaceTimeline(nextIntervals, `Deleted cut ${formatSeconds(cut.startSec)}-${formatSeconds(cut.endSec)} by restoring that source range.`);
  };

  const addCut = () => {
    if (busy || sourceDuration <= 0) {
      return;
    }
    const centerSec = activePosition?.sourceTimeSec ?? clips[0]?.sourceStartSec ?? 0;
    const startSec = clamp(centerSec - 0.5, 0, Math.max(0, sourceDuration - MIN_CUT_DURATION_SEC));
    const endSec = clamp(centerSec + 0.5, startSec + MIN_CUT_DURATION_SEC, sourceDuration);
    const nextCuts = normalizeSourceRanges(sourceDuration, [
      ...cutRanges,
      { id: `cut_${cutRanges.length + 1}`, startSec, endSec },
    ]);
    const nextIntervals = invertCutRanges(nextCuts, sourceDuration);
    onReplaceTimeline(nextIntervals, `Added cut ${formatSeconds(startSec)}-${formatSeconds(endSec)} around the current playhead.`);
  };

  return (
    <section className="timeline-pane panel">
      <div className="timeline-header">
        <div>
          <h2>Timeline</h2>
          <p className="muted">
            {clips.length} clip{clips.length === 1 ? '' : 's'} · {cutRanges.length} cut{cutRanges.length === 1 ? '' : 's'} · {formatSeconds(durationSec)} total
          </p>
        </div>
        <div className="timeline-readout">
          <button className="timeline-add-cut secondary" type="button" onClick={addCut} disabled={busy || sourceDuration <= 0} title="Add cut at playhead">
            <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>Add cut</span>
          </button>
          <strong>{formatSeconds(currentTimeSec)}</strong>
          <span className="muted">
            {activePosition ? `Clip ${activePosition.clipIndex + 1}/${clips.length}` : 'No active clip'}
          </span>
        </div>
      </div>

      <div ref={trackRef} className="timeline-track" aria-label="Source timeline with non-destructive cuts">
        {sourceDuration > 0 && clips.length > 0 ? (
          timelineItems.map((item, index) => {
            const itemStyle = timelineItemStyle(item, trackTotal, trackWidthPx);
            if (item.type === 'cut') {
              const dragging = dragState?.cut.id === item.range.id;
              return (
                <div
                  key={`cut-${item.range.id}`}
                  className={dragging ? 'timeline-cut dragging' : 'timeline-cut'}
                  style={itemStyle}
                  title={`Cut source ${formatSeconds(item.startSec)}-${formatSeconds(item.endSec)}`}
                  data-cut-trigger="true"
                  onPointerDown={(event) => startCutResizeFromEdge(item.range, event)}
                  onMouseDown={(event) => startCutResizeFromEdge(item.range, event)}
                >
                  <span
                    className="cut-resize-handle start"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Adjust cut start"
                    onPointerDown={(event) => startCutResize(item.range, 'start', event)}
                    onMouseDown={(event) => startCutResize(item.range, 'start', event)}
                  />
                  <span className="cut-label">cut</span>
                  <small>{formatSeconds(item.startSec)}-{formatSeconds(item.endSec)}</small>
                  <button
                    type="button"
                    className="cut-delete"
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteCut(item.range);
                    }}
                    disabled={busy}
                    title="Delete cut"
                    aria-label={`Delete cut ${formatSeconds(item.startSec)}-${formatSeconds(item.endSec)}`}
                  >
                    <Trash2 size={12} strokeWidth={1.9} aria-hidden="true" />
                  </button>
                  <span
                    className="cut-resize-handle end"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Adjust cut end"
                    onPointerDown={(event) => startCutResize(item.range, 'end', event)}
                    onMouseDown={(event) => startCutResize(item.range, 'end', event)}
                  />
                </div>
              );
            }
            const active = Boolean(activePosition && activePosition.sourceTimeSec >= item.startSec && activePosition.sourceTimeSec <= item.endSec);
            return (
              <button
                key={`clip-${item.range.id}`}
                type="button"
                className={active ? 'timeline-clip active' : 'timeline-clip'}
                style={itemStyle}
                title={`Kept source ${formatSeconds(item.startSec)}-${formatSeconds(item.endSec)}`}
                onPointerDown={(event) => startClipBoundaryResize(timelineItems[index - 1], timelineItems[index + 1], event)}
                onMouseDown={(event) => startClipBoundaryResize(timelineItems[index - 1], timelineItems[index + 1], event)}
                onClick={() => {
                  if (suppressNextClipClickRef.current) {
                    suppressNextClipClickRef.current = false;
                    return;
                  }
                  onSeek(sourceToVirtualTime(keptIntervals, item.startSec));
                }}
              >
                <span>{formatSeconds(item.startSec)}</span>
                <small>{formatSeconds(item.startSec)}-{formatSeconds(item.endSec)}</small>
              </button>
            );
          })
        ) : <div className="timeline-empty muted">No virtual clips yet.</div>}
      </div>
    </section>
  );
}

function commitCutChange(
  cutRanges: SourceRange[],
  sourceDuration: number,
  originalCut: SourceRange,
  nextCut: { startSec: number; endSec: number },
  onReplaceTimeline: TimelinePaneProps['onReplaceTimeline'],
) {
  if (
    Math.abs(originalCut.startSec - nextCut.startSec) < 0.01
    && Math.abs(originalCut.endSec - nextCut.endSec) < 0.01
  ) {
    return;
  }
  const nextCuts = normalizeSourceRanges(sourceDuration, [
    ...cutRanges.filter((cut) => cut.id !== originalCut.id),
    { id: originalCut.id, startSec: nextCut.startSec, endSec: nextCut.endSec },
  ]);
  const nextIntervals = invertCutRanges(nextCuts, sourceDuration);
  onReplaceTimeline(
    nextIntervals,
    `Changed cut ${formatSeconds(originalCut.startSec)}-${formatSeconds(originalCut.endSec)} to ${formatSeconds(nextCut.startSec)}-${formatSeconds(nextCut.endSec)}.`,
  );
}

function normalizeSourceRanges(durationSec: number, ranges: Array<{ id?: string; startSec: number; endSec: number }>): SourceRange[] {
  const normalized = ranges
    .map((range, index) => ({
      id: range.id ?? `range_${index + 1}`,
      startSec: Math.max(0, Math.min(durationSec, range.startSec)),
      endSec: Math.max(0, Math.min(durationSec, range.endSec)),
    }))
    .filter((range) => range.endSec > range.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const merged: SourceRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (!previous || range.startSec > previous.endSec) {
      merged.push({ ...range, id: `cut_${merged.length + 1}` });
      continue;
    }
    previous.endSec = Math.max(previous.endSec, range.endSec);
  }
  return merged;
}

function deriveCutRanges(keptIntervals: SourceRange[], durationSec: number): SourceRange[] {
  if (durationSec <= 0 || keptIntervals.length === 0) {
    return [];
  }
  const cuts: SourceRange[] = [];
  let cursor = 0;
  for (const interval of keptIntervals) {
    if (interval.startSec > cursor) {
      cuts.push({ id: `cut_${cuts.length + 1}`, startSec: cursor, endSec: interval.startSec });
    }
    cursor = Math.max(cursor, interval.endSec);
  }
  if (cursor < durationSec) {
    cuts.push({ id: `cut_${cuts.length + 1}`, startSec: cursor, endSec: durationSec });
  }
  return cuts;
}

function invertCutRanges(cuts: SourceRange[], durationSec: number): Array<{ startSec: number; endSec: number }> {
  const intervals: Array<{ startSec: number; endSec: number }> = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.startSec > cursor) {
      intervals.push({ startSec: cursor, endSec: cut.startSec });
    }
    cursor = Math.max(cursor, cut.endSec);
  }
  if (cursor < durationSec) {
    intervals.push({ startSec: cursor, endSec: durationSec });
  }
  return intervals;
}

function buildTimelineItems(keptIntervals: SourceRange[], cutRanges: SourceRange[]): TimelineItem[] {
  return [
    ...keptIntervals.map((range) => ({ type: 'clip' as const, startSec: range.startSec, endSec: range.endSec, range })),
    ...cutRanges.map((range) => ({ type: 'cut' as const, startSec: range.startSec, endSec: range.endSec, range })),
  ].sort((a, b) => a.startSec - b.startSec);
}

function timelineItemStyle(item: TimelineItem, trackTotal: number, trackWidthPx: number): CSSProperties {
  const durationSec = Math.max(0, item.endSec - item.startSec);
  const proportionalWidthPx = (durationSec / Math.max(trackTotal, 0.001)) * Math.max(trackWidthPx, 1);
  return {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: `${Math.max(SEGMENT_MIN_WIDTH_PX, proportionalWidthPx)}px`,
  };
}

function sourceToVirtualTime(intervals: Array<{ startSec: number; endSec: number }>, sourceSec: number): number {
  let cursor = 0;
  for (const interval of intervals) {
    if (sourceSec <= interval.startSec) {
      return cursor;
    }
    if (sourceSec <= interval.endSec) {
      return cursor + Math.max(0, sourceSec - interval.startSec);
    }
    cursor += interval.endSec - interval.startSec;
  }
  return cursor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
