import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { Maximize2, Minus, Plus, Trash2 } from 'lucide-react';
import type { AxcutClip } from '@axcut/schema';

import { formatSeconds, locateVirtualPosition, totalVirtualDuration } from '../lib/virtual-preview.js';

type TimelinePaneProps = {
  clips: AxcutClip[];
  currentTimeSec: number;
  sourceDurationSec: number;
  busy?: boolean;
  onSeek: (timeSec: number) => void;
  onPreviewSource: (sourceTimeSec: number) => void;
  onReplaceTimeline: (intervals: Array<{ startSec: number; endSec: number }>, reason: string) => void;
};

type SourceRange = {
  id: string;
  startSec: number;
  endSec: number;
};

type TimelineItem = SourceRange & {
  kind: 'kept' | 'cut';
};

type ResizeState = {
  id: number;
  cutId: string;
  edge: 'start' | 'end';
  startClientX: number;
  startSec: number;
  endSec: number;
  currentStartSec: number;
  currentEndSec: number;
  baseCuts: SourceRange[];
  pxPerSec: number;
};

type PanState = {
  startClientX: number;
  startScrollLeft: number;
};

const MIN_CUT_DURATION_SEC = 0.1;
const MIN_SOURCE_DURATION_SEC = 0.001;
const MIN_PX_PER_SEC = 0.35;
const MAX_PX_PER_SEC = 280;
const MIN_SEGMENT_WIDTH_PX = 1;
const RULER_HEIGHT_PX = 28;

export function TimelinePane({
  clips,
  currentTimeSec,
  sourceDurationSec,
  busy = false,
  onSeek,
  onPreviewSource,
  onReplaceTimeline,
}: TimelinePaneProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const resizeSequenceRef = useRef(0);
  const [viewportWidthPx, setViewportWidthPx] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [panning, setPanning] = useState(false);

  const virtualDurationSec = totalVirtualDuration(clips);
  const activePosition = locateVirtualPosition(clips, currentTimeSec);
  const sourceDuration = useMemo(
    () => Math.max(sourceDurationSec, ...clips.map((clip) => clip.sourceEndSec), MIN_SOURCE_DURATION_SEC),
    [clips, sourceDurationSec],
  );
  const fitPxPerSec = useMemo(() => (
    Math.max(MIN_PX_PER_SEC, viewportWidthPx / Math.max(sourceDuration, MIN_SOURCE_DURATION_SEC))
  ), [sourceDuration, viewportWidthPx]);
  const pxPerSec = clamp(fitPxPerSec * zoom, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
  const contentWidthPx = Math.max(viewportWidthPx, Math.ceil(sourceDuration * pxPerSec));

  const keptIntervals = useMemo(() => normalizeRanges(
    sourceDuration,
    clips.map((clip) => ({ startSec: clip.sourceStartSec, endSec: clip.sourceEndSec })),
    'clip',
  ), [clips, sourceDuration]);
  const committedCutRanges = useMemo(() => deriveCutRanges(keptIntervals, sourceDuration), [keptIntervals, sourceDuration]);
  const visibleCutRanges = useMemo(() => {
    if (!resizeState) {
      return committedCutRanges;
    }
    return normalizeRanges(sourceDuration, committedCutRanges.map((cut) => (
      cut.id === resizeState.cutId
        ? { id: cut.id, startSec: resizeState.currentStartSec, endSec: resizeState.currentEndSec }
        : cut
    )), 'cut');
  }, [committedCutRanges, resizeState, sourceDuration]);
  const visibleKeptIntervals = useMemo(() => invertCutRanges(visibleCutRanges, sourceDuration), [sourceDuration, visibleCutRanges]);
  const timelineItems = useMemo(() => buildTimelineItems(visibleKeptIntervals, visibleCutRanges), [visibleKeptIntervals, visibleCutRanges]);
  const rulerTicks = useMemo(() => buildRulerTicks(sourceDuration, pxPerSec), [pxPerSec, sourceDuration]);
  const playheadSourceSec = activePosition?.sourceTimeSec ?? null;

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

  const replaceTimelineFromCuts = useCallback((cuts: SourceRange[], reason: string) => {
    onReplaceTimeline(invertCutRanges(normalizeRanges(sourceDuration, cuts, 'cut'), sourceDuration), reason);
  }, [onReplaceTimeline, sourceDuration]);

  const seekSource = useCallback((sourceSec: number, intervals = visibleKeptIntervals) => {
    const boundedSourceSec = clamp(sourceSec, 0, sourceDuration);
    onPreviewSource(boundedSourceSec);
    onSeek(sourceToVirtualTime(intervals, boundedSourceSec));
  }, [onPreviewSource, onSeek, sourceDuration, visibleKeptIntervals]);

  const zoomAt = useCallback((nextZoom: number, anchorClientX?: number) => {
    const scrollElement = scrollRef.current;
    const boundedZoom = clamp(nextZoom, 1, MAX_PX_PER_SEC / Math.max(fitPxPerSec, MIN_PX_PER_SEC));
    if (!scrollElement) {
      setZoom(boundedZoom);
      return;
    }
    const rect = scrollElement.getBoundingClientRect();
    const anchorX = anchorClientX === undefined ? rect.left + rect.width / 2 : anchorClientX;
    const sourceAtAnchor = (scrollElement.scrollLeft + anchorX - rect.left) / pxPerSec;
    const nextPxPerSec = clamp(fitPxPerSec * boundedZoom, MIN_PX_PER_SEC, MAX_PX_PER_SEC);
    setZoom(boundedZoom);
    requestAnimationFrame(() => {
      scrollElement.scrollLeft = Math.max(0, sourceAtAnchor * nextPxPerSec - (anchorX - rect.left));
    });
  }, [fitPxPerSec, pxPerSec]);

  const fitTimeline = useCallback(() => {
    setZoom(1);
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollLeft = 0;
      }
    });
  }, []);

  const addCut = useCallback(() => {
    if (busy || sourceDuration <= MIN_SOURCE_DURATION_SEC) {
      return;
    }
    const centerSec = activePosition?.sourceTimeSec ?? clips[0]?.sourceStartSec ?? 0;
    const startSec = clamp(centerSec - 0.5, 0, Math.max(0, sourceDuration - MIN_CUT_DURATION_SEC));
    const endSec = clamp(centerSec + 0.5, startSec + MIN_CUT_DURATION_SEC, sourceDuration);
    replaceTimelineFromCuts(
      [...committedCutRanges, { id: `cut_${committedCutRanges.length + 1}`, startSec, endSec }],
      `Added cut ${formatSeconds(startSec)}-${formatSeconds(endSec)} around the current playhead.`,
    );
  }, [activePosition?.sourceTimeSec, busy, clips, committedCutRanges, replaceTimelineFromCuts, sourceDuration]);

  const deleteCut = useCallback((cut: SourceRange) => {
    if (busy) {
      return;
    }
    replaceTimelineFromCuts(
      committedCutRanges.filter((item) => item.id !== cut.id),
      `Deleted cut ${formatSeconds(cut.startSec)}-${formatSeconds(cut.endSec)} by restoring that source range.`,
    );
  }, [busy, committedCutRanges, replaceTimelineFromCuts]);

  const startResize = useCallback((cut: SourceRange, edge: ResizeState['edge'], event: ReactPointerEvent<HTMLElement>) => {
    if (busy) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const nextState: ResizeState = {
      id: resizeSequenceRef.current + 1,
      cutId: cut.id,
      edge,
      startClientX: event.clientX,
      startSec: cut.startSec,
      endSec: cut.endSec,
      currentStartSec: cut.startSec,
      currentEndSec: cut.endSec,
      baseCuts: committedCutRanges,
      pxPerSec,
    };
    resizeSequenceRef.current = nextState.id;
    resizeRef.current = nextState;
    setResizeState(nextState);
    seekSource(edge === 'start' ? cut.startSec : cut.endSec);

    const move = (moveEvent: PointerEvent) => {
      const current = resizeRef.current;
      if (!current) {
        return;
      }
      const deltaSec = (moveEvent.clientX - current.startClientX) / Math.max(current.pxPerSec, MIN_PX_PER_SEC);
      const currentIndex = current.baseCuts.findIndex((item) => item.id === current.cutId);
      const previousCut = currentIndex > 0 ? current.baseCuts[currentIndex - 1] : null;
      const nextCut = currentIndex >= 0 && currentIndex < current.baseCuts.length - 1 ? current.baseCuts[currentIndex + 1] : null;
      const nextStartSec = current.edge === 'start'
        ? clamp(current.startSec + deltaSec, previousCut?.endSec ?? 0, current.currentEndSec - MIN_CUT_DURATION_SEC)
        : current.currentStartSec;
      const nextEndSec = current.edge === 'end'
        ? clamp(current.endSec + deltaSec, current.currentStartSec + MIN_CUT_DURATION_SEC, nextCut?.startSec ?? sourceDuration)
        : current.currentEndSec;
      const nextState = { ...current, currentStartSec: nextStartSec, currentEndSec: nextEndSec };
      resizeRef.current = nextState;
      setResizeState(nextState);
      const nextCuts = current.baseCuts.map((item) => (
        item.id === current.cutId ? { ...item, startSec: nextStartSec, endSec: nextEndSec } : item
      ));
      const boundarySec = current.edge === 'start' ? nextStartSec : nextEndSec;
      seekSource(boundarySec, invertCutRanges(nextCuts, sourceDuration));
    };

    const end = () => {
      const current = resizeRef.current;
      resizeRef.current = null;
      setResizeState(null);
      globalThis.document.body.classList.remove('timeline-resizing-cut');
      globalThis.window.removeEventListener('pointermove', move);
      globalThis.window.removeEventListener('pointerup', end);
      globalThis.window.removeEventListener('pointercancel', end);
      if (!current) {
        return;
      }
      if (Math.abs(current.currentStartSec - current.startSec) < 0.01 && Math.abs(current.currentEndSec - current.endSec) < 0.01) {
        return;
      }
      replaceTimelineFromCuts(
        current.baseCuts.map((item) => (
          item.id === current.cutId ? { ...item, startSec: current.currentStartSec, endSec: current.currentEndSec } : item
        )),
        `Changed cut ${formatSeconds(current.startSec)}-${formatSeconds(current.endSec)} to ${formatSeconds(current.currentStartSec)}-${formatSeconds(current.currentEndSec)}.`,
      );
    };

    globalThis.document.body.classList.add('timeline-resizing-cut');
    globalThis.window.addEventListener('pointermove', move);
    globalThis.window.addEventListener('pointerup', end, { once: true });
    globalThis.window.addEventListener('pointercancel', end, { once: true });
  }, [busy, committedCutRanges, replaceTimelineFromCuts, pxPerSec, seekSource, sourceDuration]);

  const startPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (busy || target?.closest('button, .timeline-segment, .timeline-cut-handle')) {
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

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }
    event.preventDefault();
    const direction = event.deltaY > 0 ? -1 : 1;
    zoomAt(zoom * (direction > 0 ? 1.18 : 1 / 1.18), event.clientX);
  }, [zoom, zoomAt]);

  return (
    <section className="timeline-pane panel">
      <div className="timeline-header">
        <div>
          <h2>Timeline</h2>
          <p className="muted">
            {clips.length} clip{clips.length === 1 ? '' : 's'} · {committedCutRanges.length} cut{committedCutRanges.length === 1 ? '' : 's'} · {formatSeconds(virtualDurationSec)} total
          </p>
        </div>
        <div className="timeline-readout">
          <button className="timeline-tool secondary" type="button" onClick={addCut} disabled={busy || clips.length === 0} title="Add cut at playhead">
            <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>Add cut</span>
          </button>
          <div className="timeline-zoom-controls" aria-label="Timeline zoom controls">
            <button className="timeline-icon-button secondary" type="button" onClick={() => zoomAt(zoom / 1.35)} disabled={zoom <= 1.01} title="Zoom out">
              <Minus size={14} strokeWidth={1.9} aria-hidden="true" />
              <span className="sr-only">Zoom out</span>
            </button>
            <input
              aria-label="Timeline zoom"
              className="timeline-zoom-slider"
              type="range"
              min="1"
              max="32"
              step="0.1"
              value={Math.min(32, zoom)}
              onChange={(event) => zoomAt(Number(event.target.value))}
            />
            <button className="timeline-icon-button secondary" type="button" onClick={() => zoomAt(zoom * 1.35)} title="Zoom in">
              <Plus size={14} strokeWidth={1.9} aria-hidden="true" />
              <span className="sr-only">Zoom in</span>
            </button>
            <button className="timeline-icon-button secondary" type="button" onClick={fitTimeline} disabled={zoom <= 1.01} title="Fit timeline">
              <Maximize2 size={14} strokeWidth={1.8} aria-hidden="true" />
              <span className="sr-only">Fit timeline</span>
            </button>
          </div>
          <strong>{formatSeconds(currentTimeSec)}</strong>
          <span className="muted">{activePosition ? `Clip ${activePosition.clipIndex + 1}/${clips.length}` : 'No active clip'}</span>
        </div>
      </div>

      <div
        ref={scrollRef}
        className={panning ? 'timeline-viewport panning' : 'timeline-viewport'}
        onPointerDown={startPan}
        onWheel={handleWheel}
        aria-label="Source timeline. Drag empty space to pan, use controls or Ctrl wheel to zoom."
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
              {timelineItems.map((item) => {
                const style = timelineItemStyle(item, pxPerSec);
                if (item.kind === 'cut') {
                  const active = resizeState?.cutId === item.id;
                  return (
                    <div
                      key={item.id}
                      className={active ? 'timeline-segment timeline-cut active' : 'timeline-segment timeline-cut'}
                      style={style}
                      title={`Cut source ${formatSeconds(item.startSec)}-${formatSeconds(item.endSec)}`}
                    >
                      <button
                        className="timeline-cut-handle start"
                        type="button"
                        onPointerDown={(event) => startResize(item, 'start', event)}
                        disabled={busy}
                        aria-label={`Adjust cut start at ${formatSeconds(item.startSec)}`}
                        title="Adjust cut start"
                      />
                      <div className="timeline-segment-label">
                        <span>Cut</span>
                        <small>{formatSeconds(item.startSec)}-{formatSeconds(item.endSec)}</small>
                      </div>
                      <button
                        className="timeline-cut-delete"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteCut(item);
                        }}
                        disabled={busy}
                        title="Delete cut"
                        aria-label={`Delete cut ${formatSeconds(item.startSec)}-${formatSeconds(item.endSec)}`}
                      >
                        <Trash2 size={12} strokeWidth={1.9} aria-hidden="true" />
                      </button>
                      <button
                        className="timeline-cut-handle end"
                        type="button"
                        onPointerDown={(event) => startResize(item, 'end', event)}
                        disabled={busy}
                        aria-label={`Adjust cut end at ${formatSeconds(item.endSec)}`}
                        title="Adjust cut end"
                      />
                    </div>
                  );
                }
                const active = playheadSourceSec !== null && playheadSourceSec >= item.startSec && playheadSourceSec <= item.endSec;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={active ? 'timeline-segment timeline-kept active' : 'timeline-segment timeline-kept'}
                    style={style}
                    onClick={() => seekSource(item.startSec)}
                    title={`Kept source ${formatSeconds(item.startSec)}-${formatSeconds(item.endSec)}`}
                  >
                    <div className="timeline-segment-label">
                      <span>{formatSeconds(item.startSec)}</span>
                      <small>{formatSeconds(item.startSec)}-{formatSeconds(item.endSec)}</small>
                    </div>
                  </button>
                );
              })}
              {playheadSourceSec !== null ? (
                <div className="timeline-playhead" style={{ left: `${playheadSourceSec * pxPerSec}px` }} aria-hidden="true" />
              ) : null}
            </div>
          </div>
        ) : (
          <div className="timeline-empty muted">No virtual clips yet.</div>
        )}
      </div>
    </section>
  );
}

function normalizeRanges(durationSec: number, ranges: Array<{ id?: string; startSec: number; endSec: number }>, idPrefix: string): SourceRange[] {
  const normalized = ranges
    .map((range, index) => ({
      id: range.id ?? `${idPrefix}_${index + 1}`,
      startSec: clamp(range.startSec, 0, durationSec),
      endSec: clamp(range.endSec, 0, durationSec),
    }))
    .filter((range) => range.endSec > range.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const merged: SourceRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (!previous || range.startSec > previous.endSec) {
      merged.push({ ...range, id: `${idPrefix}_${merged.length + 1}` });
      continue;
    }
    previous.endSec = Math.max(previous.endSec, range.endSec);
  }
  return merged;
}

function deriveCutRanges(keptIntervals: SourceRange[], durationSec: number): SourceRange[] {
  if (durationSec <= MIN_SOURCE_DURATION_SEC || keptIntervals.length === 0) {
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

function invertCutRanges(cuts: SourceRange[], durationSec: number): SourceRange[] {
  const intervals: SourceRange[] = [];
  let cursor = 0;
  for (const cut of normalizeRanges(durationSec, cuts, 'cut')) {
    if (cut.startSec > cursor) {
      intervals.push({ id: `clip_${intervals.length + 1}`, startSec: cursor, endSec: cut.startSec });
    }
    cursor = Math.max(cursor, cut.endSec);
  }
  if (cursor < durationSec) {
    intervals.push({ id: `clip_${intervals.length + 1}`, startSec: cursor, endSec: durationSec });
  }
  return intervals;
}

function buildTimelineItems(keptIntervals: SourceRange[], cutRanges: SourceRange[]): TimelineItem[] {
  return [
    ...keptIntervals.map((range) => ({ ...range, kind: 'kept' as const })),
    ...cutRanges.map((range) => ({ ...range, kind: 'cut' as const })),
  ].sort((a, b) => a.startSec - b.startSec || (a.kind === 'kept' ? -1 : 1));
}

function timelineItemStyle(item: TimelineItem, pxPerSec: number): CSSProperties {
  return {
    left: `${item.startSec * pxPerSec}px`,
    width: `${Math.max(MIN_SEGMENT_WIDTH_PX, (item.endSec - item.startSec) * pxPerSec)}px`,
    minWidth: `${MIN_SEGMENT_WIDTH_PX}px`,
  };
}

function buildRulerTicks(durationSec: number, pxPerSec: number): Array<{ timeSec: number; major: boolean }> {
  const majorStepSec = chooseTickStep(90 / Math.max(pxPerSec, MIN_PX_PER_SEC));
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
