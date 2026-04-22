import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AxcutClip } from '@axcut/schema';

import { clampVirtualTime, formatSeconds, locateSourcePosition, locateVirtualPosition, totalVirtualDuration } from '../lib/virtual-preview.js';

type VirtualPreviewProps = {
  videoSrc: string | null;
  clips: AxcutClip[];
  revision: number;
};

export function VirtualPreview({ videoSrc, clips, revision }: VirtualPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isProgrammaticSeekRef = useRef(false);
  const [virtualTimeSec, setVirtualTimeSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const virtualDurationSec = useMemo(() => totalVirtualDuration(clips), [clips]);
  const activePosition = useMemo(() => locateVirtualPosition(clips, virtualTimeSec), [clips, virtualTimeSec]);

  const seekToVirtualTime = useCallback((nextVirtualTimeSec: number, preservePlayback = false) => {
    const video = videoRef.current;
    const position = locateVirtualPosition(clips, nextVirtualTimeSec);
    if (!video || !position) {
      setVirtualTimeSec(0);
      setIsPlaying(false);
      return;
    }
    const shouldContinuePlayback = preservePlayback && !video.paused;
    isProgrammaticSeekRef.current = true;
    setVirtualTimeSec(position.virtualTimeSec);
    if (Math.abs(video.currentTime - position.sourceTimeSec) > 0.01) {
      video.currentTime = position.sourceTimeSec;
    }
    if (shouldContinuePlayback) {
      void video.play().catch(() => {
        setIsPlaying(false);
      });
    }
  }, [clips]);

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
    setVirtualTimeSec(position.virtualTimeSec);
    if (Math.abs(video.currentTime - position.sourceTimeSec) > 0.01) {
      video.currentTime = position.sourceTimeSec;
    }
    void video.play().then(() => {
      setIsPlaying(true);
    }).catch(() => {
      setIsPlaying(false);
    });
  }, [clips, virtualTimeSec]);

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
        setVirtualTimeSec(virtualDurationSec);
        setIsPlaying(false);
        return;
      }
      seekToVirtualTime(nextClip.timelineStartSec, true);
      return;
    }

    setVirtualTimeSec(clampVirtualTime(clips, position.virtualTimeSec));
  }, [clips, seekToVirtualTime, virtualDurationSec]);

  useEffect(() => {
    const video = videoRef.current;
    setIsPlaying(false);
    setVirtualTimeSec(0);
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
  }, [clips, revision, videoSrc]);

  return (
    <>
      <p className="muted preview-summary">
        Seek-based virtual preview · {clips.length} clip{clips.length === 1 ? '' : 's'} · {formatSeconds(virtualDurationSec)}
      </p>
      {videoSrc ? (
        <>
          <video
            ref={videoRef}
            src={videoSrc}
            className="video"
            preload="metadata"
            onPause={() => setIsPlaying(false)}
            onPlay={() => setIsPlaying(true)}
            onTimeUpdate={handleTimeUpdate}
          />

          <div className="preview-controls">
            <button onClick={handlePlayPause} disabled={clips.length === 0}>
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button onClick={() => seekToVirtualTime(0)} disabled={clips.length === 0}>Restart</button>
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
              disabled={clips.length === 0}
            />
          </div>

          <div className="preview-meta muted">
            {activePosition
              ? `Previewing clip ${activePosition.clipIndex + 1}/${clips.length} at source ${formatSeconds(activePosition.sourceTimeSec)}`
              : 'No virtual timeline available yet.'}
          </div>

          <div className="timeline interactive">
            {clips.length > 0 ? clips.map((clip) => {
              const total = Math.max(virtualDurationSec, 0.001);
              const width = `${Math.max(4, ((clip.timelineEndSec - clip.timelineStartSec) / total) * 100)}%`;
              const active = activePosition?.clip.id === clip.id;
              return (
                <button
                  key={clip.id}
                  className={active ? 'timeline-clip active' : 'timeline-clip'}
                  style={{ width }}
                  title={`${formatSeconds(clip.timelineStartSec)} → ${formatSeconds(clip.timelineEndSec)}`}
                  onClick={() => seekToVirtualTime(clip.timelineStartSec)}
                >
                  {formatSeconds(clip.sourceStartSec)}-{formatSeconds(clip.sourceEndSec)}
                </button>
              );
            }) : <div className="muted">No virtual clips yet.</div>}
          </div>
        </>
      ) : <div className="video placeholder">Attach a video to start previewing.</div>}
    </>
  );
}
