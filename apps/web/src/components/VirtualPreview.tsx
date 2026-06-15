import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AxcutClip } from '@axcut/schema';
import { Pause, Play, RotateCcw } from 'lucide-react';

import { clampVirtualTime, formatSeconds, locateSourcePosition, locateVirtualPosition, totalVirtualDuration } from '../lib/virtual-preview.js';

type VirtualPreviewProps = {
  videoSources: Array<{ src: string; label: string }>;
  clips: AxcutClip[];
  revision: number;
  seekTarget?: { timeSec: number; requestId: number } | null;
  sourcePreviewTarget?: { sourceTimeSec: number; requestId: number } | null;
  onTimeChange?: (timeSec: number) => void;
};

export function VirtualPreview({ videoSources, clips, revision, seekTarget, sourcePreviewTarget, onTimeChange }: VirtualPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isProgrammaticSeekRef = useRef(false);
  const [virtualTimeSec, setVirtualTimeSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [sourceIndex, setSourceIndex] = useState(0);

  const virtualDurationSec = useMemo(() => totalVirtualDuration(clips), [clips]);
  const activeSource = videoSources[sourceIndex] ?? null;

  const updateVirtualTime = useCallback((nextTimeSec: number) => {
    setVirtualTimeSec(nextTimeSec);
    onTimeChange?.(nextTimeSec);
  }, [onTimeChange]);

  const seekToVirtualTime = useCallback((nextVirtualTimeSec: number, preservePlayback = false) => {
    const video = videoRef.current;
    const position = locateVirtualPosition(clips, nextVirtualTimeSec);
    if (!video || !position) {
      updateVirtualTime(0);
      setIsPlaying(false);
      return;
    }
    const shouldContinuePlayback = preservePlayback && !video.paused;
    isProgrammaticSeekRef.current = true;
    updateVirtualTime(position.virtualTimeSec);
    if (Math.abs(video.currentTime - position.sourceTimeSec) > 0.01) {
      video.currentTime = position.sourceTimeSec;
    }
    if (shouldContinuePlayback) {
      void video.play().catch(() => {
        setIsPlaying(false);
      });
    }
  }, [clips, updateVirtualTime]);

  const handlePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video || clips.length === 0) {
      return;
    }
    if (!video.paused) {
      video.pause();
      setIsPlaying(false);
      return;
    }
    const position = locateVirtualPosition(clips, virtualTimeSec) ?? locateVirtualPosition(clips, 0);
    if (!position) {
      return;
    }
    isProgrammaticSeekRef.current = true;
    updateVirtualTime(position.virtualTimeSec);
    if (Math.abs(video.currentTime - position.sourceTimeSec) > 0.01) {
      video.currentTime = position.sourceTimeSec;
    }
    void video.play().then(() => {
      setIsPlaying(true);
    }).catch(() => {
      setIsPlaying(false);
    });
  }, [clips, updateVirtualTime, virtualTimeSec]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || clips.length === 0) {
      return;
    }
    if (isProgrammaticSeekRef.current) {
      isProgrammaticSeekRef.current = false;
    }

    const position = locateSourcePosition(clips, video.currentTime);
    if (!position) {
      const nextClip = clips.find((clip) => clip.sourceStartSec > video.currentTime);
      if (nextClip) {
        seekToVirtualTime(nextClip.timelineStartSec, true);
      }
      return;
    }

    const currentClip = position.clip;
    const reachedClipEnd = video.currentTime >= currentClip.sourceEndSec - 0.04;
    if (reachedClipEnd) {
      const nextClip = clips[position.clipIndex + 1];
      if (!nextClip) {
        video.pause();
        updateVirtualTime(virtualDurationSec);
        setIsPlaying(false);
        return;
      }
      seekToVirtualTime(nextClip.timelineStartSec, true);
      return;
    }

    updateVirtualTime(clampVirtualTime(clips, position.virtualTimeSec));
  }, [clips, seekToVirtualTime, updateVirtualTime, virtualDurationSec]);

  useEffect(() => {
    const video = videoRef.current;
    setIsPlaying(false);
    updateVirtualTime(0);
    setSourceIndex(0);
    setLoadState(videoSources.length > 0 ? 'loading' : 'idle');
    if (!video) {
      return;
    }
    video.pause();
    if (clips.length > 0) {
      const start = locateVirtualPosition(clips, 0);
      if (start) {
        video.currentTime = start.sourceTimeSec;
      }
    }
  }, [revision, updateVirtualTime, videoSources]);

  useEffect(() => {
    if (!seekTarget) {
      return;
    }
    seekToVirtualTime(seekTarget.timeSec);
  }, [seekTarget, seekToVirtualTime]);

  useEffect(() => {
    if (!sourcePreviewTarget) {
      return;
    }
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.pause();
    setIsPlaying(false);
    isProgrammaticSeekRef.current = true;
    if (Math.abs(video.currentTime - sourcePreviewTarget.sourceTimeSec) > 0.01) {
      video.currentTime = sourcePreviewTarget.sourceTimeSec;
    }
  }, [sourcePreviewTarget]);

  return (
    <>
      {activeSource ? (
        <>
          <div className="video-frame">
            <video
              key={activeSource.src}
              ref={videoRef}
              src={activeSource.src}
              className="video"
              preload="metadata"
              playsInline
              onLoadedMetadata={() => {
                setLoadState('ready');
                if (clips.length > 0) {
                  seekToVirtualTime(virtualTimeSec);
                }
              }}
              onWaiting={() => setLoadState('loading')}
              onCanPlay={() => setLoadState('ready')}
              onError={() => {
                if (sourceIndex + 1 < videoSources.length) {
                  setSourceIndex((current) => current + 1);
                  setLoadState('loading');
                  return;
                }
                setLoadState('error');
                setIsPlaying(false);
              }}
              onPause={() => setIsPlaying(false)}
              onPlay={() => setIsPlaying(true)}
              onEnded={() => setIsPlaying(false)}
              onTimeUpdate={handleTimeUpdate}
            />
            {loadState !== 'ready' ? (
              <div className="video-overlay muted">
                {loadState === 'error' ? 'Video preview could not be loaded.' : 'Loading preview media...'}
              </div>
            ) : null}
          </div>

          <div className="preview-controls">
            <button className="icon-action" onClick={handlePlayPause} disabled={clips.length === 0 || loadState !== 'ready'} title={isPlaying ? 'Pause' : 'Play'} aria-label={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying ? <Pause size={16} strokeWidth={1.8} aria-hidden="true" /> : <Play size={16} strokeWidth={1.8} aria-hidden="true" />}
              <span className="sr-only">{isPlaying ? 'Pause' : 'Play'}</span>
            </button>
            <button className="icon-action secondary" onClick={() => seekToVirtualTime(0)} disabled={clips.length === 0 || loadState !== 'ready'} title="Restart" aria-label="Restart">
              <RotateCcw size={16} strokeWidth={1.8} aria-hidden="true" />
              <span className="sr-only">Restart</span>
            </button>
            <div className="preview-readout">
              <strong>{formatSeconds(virtualTimeSec)}</strong>
              <span className="muted">/ {formatSeconds(virtualDurationSec)}</span>
            </div>
            <input
              className="timeline-slider"
              type="range"
              min={0}
              max={Math.max(virtualDurationSec, 0.001)}
              step={0.01}
              value={Math.min(virtualTimeSec, Math.max(virtualDurationSec, 0.001))}
              onChange={(event) => {
                const nextValue = Number.parseFloat(event.target.value);
                seekToVirtualTime(nextValue);
              }}
              disabled={clips.length === 0 || loadState !== 'ready'}
            />
          </div>

          {loadState === 'error' ? (
            <div className="preview-meta muted">Preview request failed. Verify the source or proxy file exists and is streamable.</div>
          ) : null}
        </>
      ) : <div className="video placeholder">Attach a video to start previewing.</div>}
    </>
  );
}
