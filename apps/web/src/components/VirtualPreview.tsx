import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, SyntheticEvent } from 'react';
import type { AxcutClip } from '@axcut/schema';
import { Maximize2, Minimize2, Pause, Play, RotateCcw } from 'lucide-react';

import { clampVirtualTime, formatSeconds, locateVirtualPosition, resolvePlaybackPosition, totalVirtualDuration } from '../lib/virtual-preview.js';

type VideoSource = { assetId: string; src: string; label: string };

type VirtualPreviewProps = {
  videoSources: VideoSource[];
  clips: AxcutClip[];
  revision: number;
  seekTarget?: { timeSec: number; requestId: number } | null;
  sourcePreviewTarget?: { assetId?: string; sourceTimeSec: number; requestId: number } | null;
  onTimeChange?: (timeSec: number) => void;
};

type VideoLayer = 0 | 1;

type PendingSourceSeek = {
  assetId: string;
  sourceTimeSec: number;
  play: boolean;
  layer: VideoLayer;
};

type PreloadTarget = {
  source: VideoSource;
  sourceTimeSec: number;
};

const CLIP_END_LOOKAHEAD_SEC = 0.04;
const MEDIA_HAVE_METADATA = 1;
const MEDIA_HAVE_CURRENT_DATA = 2;

export function VirtualPreview({ videoSources, clips, revision, seekTarget, sourcePreviewTarget, onTimeChange }: VirtualPreviewProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const videoARef = useRef<HTMLVideoElement | null>(null);
  const videoBRef = useRef<HTMLVideoElement | null>(null);
  const pendingSourceSeekRef = useRef<PendingSourceSeek | null>(null);
  const virtualTimeRef = useRef(0);
  const [activeLayer, setActiveLayer] = useState<VideoLayer>(0);
  const [layerSources, setLayerSources] = useState<[VideoSource | null, VideoSource | null]>([null, null]);
  const [virtualTimeSec, setVirtualTimeSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  const virtualDurationSec = useMemo(() => totalVirtualDuration(clips), [clips]);
  const sourcesByAssetId = useMemo(() => {
    const map = new Map<string, VideoSource[]>();
    for (const source of videoSources) {
      const sources = map.get(source.assetId) ?? [];
      sources.push(source);
      map.set(source.assetId, sources);
    }
    return map;
  }, [videoSources]);
  const activeSource = layerSources[activeLayer] ?? null;
  const inactiveLayer: VideoLayer = activeLayer === 0 ? 1 : 0;
  const sliderProgress = virtualDurationSec > 0
    ? Math.max(0, Math.min(100, (virtualTimeSec / virtualDurationSec) * 100))
    : 0;

  const getVideo = useCallback((layer: VideoLayer) => (
    layer === 0 ? videoARef.current : videoBRef.current
  ), []);

  const sourceForAsset = useCallback((assetId: string | undefined) => (
    assetId ? sourcesByAssetId.get(assetId)?.[0] ?? null : null
  ), [sourcesByAssetId]);

  const fallbackSourceForAsset = useCallback((assetId: string, failedSrc: string) => (
    sourcesByAssetId.get(assetId)?.find((source) => source.src !== failedSrc) ?? null
  ), [sourcesByAssetId]);

  const updateVirtualTime = useCallback((nextTimeSec: number) => {
    virtualTimeRef.current = nextTimeSec;
    setVirtualTimeSec(nextTimeSec);
    onTimeChange?.(nextTimeSec);
  }, [onTimeChange]);

  const activateLayer = useCallback(async (layer: VideoLayer, sourceTimeSec: number, play: boolean) => {
    const nextVideo = getVideo(layer);
    const previousVideo = getVideo(layer === 0 ? 1 : 0);
    if (!nextVideo) {
      return false;
    }

    if (Math.abs(nextVideo.currentTime - sourceTimeSec) > 0.015) {
      nextVideo.currentTime = sourceTimeSec;
    }

    try {
      if (play) {
        await nextVideo.play();
      } else {
        nextVideo.pause();
      }
      if (previousVideo && previousVideo !== nextVideo) {
        previousVideo.pause();
      }
      setActiveLayer(layer);
      setLoadState('ready');
      setIsPlaying(play);
      return true;
    } catch {
      setIsPlaying(false);
      setLoadState('ready');
      return false;
    }
  }, [getVideo]);

  const seekSource = useCallback((assetId: string, sourceTimeSec: number, play: boolean) => {
    const source = sourceForAsset(assetId);
    if (!source) {
      setLoadState(videoSources.length > 0 ? 'error' : 'idle');
      setIsPlaying(false);
      return;
    }

    const activeVideo = getVideo(activeLayer);
    if (activeSource?.assetId === assetId && activeVideo) {
      if (Math.abs(activeVideo.currentTime - sourceTimeSec) > 0.01) {
        activeVideo.currentTime = sourceTimeSec;
      }
      if (play) {
        void activeVideo.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
      } else {
        activeVideo.pause();
        setIsPlaying(false);
      }
      setLoadState(activeVideo.readyState >= MEDIA_HAVE_METADATA ? 'ready' : 'loading');
      return;
    }

    const targetLayer = inactiveLayer;
    const targetVideo = getVideo(targetLayer);
    const targetSource = layerSources[targetLayer];
    pendingSourceSeekRef.current = { assetId, sourceTimeSec, play, layer: targetLayer };
    if (targetVideo && targetSource?.src === source.src && targetVideo.readyState >= MEDIA_HAVE_METADATA) {
      pendingSourceSeekRef.current = null;
      void activateLayer(targetLayer, sourceTimeSec, play);
      return;
    }
    setLayerSources((current) => (
      current[targetLayer]?.src === source.src
        ? current
        : targetLayer === 0 ? [source, current[1]] : [current[0], source]
    ));
    setLoadState('loading');
  }, [activateLayer, activeLayer, activeSource?.assetId, getVideo, inactiveLayer, layerSources, sourceForAsset, videoSources.length]);

  const seekToVirtualTime = useCallback((nextVirtualTimeSec: number, preservePlayback = false) => {
    const activeVideo = getVideo(activeLayer);
    const position = locateVirtualPosition(clips, nextVirtualTimeSec);
    if (!position) {
      updateVirtualTime(0);
      setIsPlaying(false);
      return;
    }
    const shouldContinuePlayback = preservePlayback && Boolean(activeVideo && !activeVideo.paused);
    updateVirtualTime(position.virtualTimeSec);
    seekSource(position.clip.assetId, position.sourceTimeSec, shouldContinuePlayback);
  }, [activeLayer, clips, getVideo, seekSource, updateVirtualTime]);

  const preloadTarget = useMemo<PreloadTarget | null>(() => {
    const position = locateVirtualPosition(clips, virtualTimeSec);
    const nextClip = position ? clips[position.clipIndex + 1] : clips[0];
    if (!nextClip || nextClip.assetId === activeSource?.assetId) {
      return null;
    }
    const source = sourceForAsset(nextClip.assetId);
    return source ? { source, sourceTimeSec: nextClip.sourceStartSec } : null;
  }, [activeSource?.assetId, clips, sourceForAsset, virtualTimeSec]);

  const switchToClip = useCallback((clip: AxcutClip) => {
    const source = sourceForAsset(clip.assetId);
    if (!source) {
      seekToVirtualTime(clip.timelineStartSec, true);
      return;
    }
    const bufferVideo = getVideo(inactiveLayer);
    const bufferSource = layerSources[inactiveLayer];
    if (bufferVideo && bufferSource?.src === source.src && bufferVideo.readyState >= MEDIA_HAVE_CURRENT_DATA) {
      updateVirtualTime(clip.timelineStartSec);
      void activateLayer(inactiveLayer, clip.sourceStartSec, true).then((activated) => {
        if (!activated) {
          seekToVirtualTime(clip.timelineStartSec, true);
        }
      });
      return;
    }
    seekToVirtualTime(clip.timelineStartSec, true);
  }, [activateLayer, getVideo, inactiveLayer, layerSources, seekToVirtualTime, sourceForAsset, updateVirtualTime]);

  const syncPlaybackPosition = useCallback(() => {
    const video = getVideo(activeLayer);
    if (!video || clips.length === 0) {
      return;
    }

    const expectedPosition = locateVirtualPosition(clips, virtualTimeRef.current);
    const expectedClip = expectedPosition?.clip;
    const playbackPosition = expectedPosition
      && expectedClip
      && (!activeSource?.assetId || expectedClip.assetId === activeSource.assetId)
      && video.currentTime >= expectedClip.sourceStartSec - 0.05
      && video.currentTime <= expectedClip.sourceEndSec + 0.05
      ? {
          kind: 'inside' as const,
          position: {
            ...expectedPosition,
            sourceTimeSec: video.currentTime,
            virtualTimeSec: expectedClip.timelineStartSec + Math.max(0, video.currentTime - expectedClip.sourceStartSec),
          },
        }
      : resolvePlaybackPosition(clips, video.currentTime, activeSource?.assetId);
    if (playbackPosition.kind === 'empty') {
      return;
    }
    if (playbackPosition.kind === 'next') {
      switchToClip(playbackPosition.position.clip);
      return;
    }
    if (playbackPosition.kind === 'ended') {
      video.pause();
      if (Math.abs(video.currentTime - playbackPosition.position.sourceTimeSec) > 0.01) {
        video.currentTime = playbackPosition.position.sourceTimeSec;
      }
      updateVirtualTime(virtualDurationSec);
      setIsPlaying(false);
      return;
    }

    const position = playbackPosition.position;
    const currentClip = position.clip;
    const reachedClipEnd = video.currentTime >= currentClip.sourceEndSec - CLIP_END_LOOKAHEAD_SEC;
    if (reachedClipEnd) {
      const nextClip = clips[position.clipIndex + 1];
      if (!nextClip) {
        video.pause();
        if (Math.abs(video.currentTime - currentClip.sourceEndSec) > 0.01) {
          video.currentTime = currentClip.sourceEndSec;
        }
        updateVirtualTime(virtualDurationSec);
        setIsPlaying(false);
        return;
      }
      switchToClip(nextClip);
      return;
    }

    updateVirtualTime(clampVirtualTime(clips, position.virtualTimeSec));
  }, [activeLayer, activeSource?.assetId, clips, getVideo, switchToClip, updateVirtualTime, virtualDurationSec]);

  const handlePlayPause = useCallback(() => {
    const video = getVideo(activeLayer);
    if (!video || clips.length === 0 || virtualDurationSec <= 0) {
      return;
    }
    if (!video.paused) {
      video.pause();
      setIsPlaying(false);
      return;
    }
    const playbackStartSec = virtualTimeSec >= virtualDurationSec - 0.01 ? 0 : virtualTimeSec;
    const position = locateVirtualPosition(clips, playbackStartSec) ?? locateVirtualPosition(clips, 0);
    if (!position) {
      return;
    }
    updateVirtualTime(position.virtualTimeSec);
    seekSource(position.clip.assetId, position.sourceTimeSec, true);
  }, [activeLayer, clips, getVideo, seekSource, updateVirtualTime, virtualDurationSec, virtualTimeSec]);

  const toggleFullscreen = useCallback(() => {
    const frame = frameRef.current;
    if (!frame || !document.fullscreenEnabled) {
      return;
    }
    if (document.fullscreenElement === frame) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void frame.requestFullscreen().catch(() => undefined);
  }, []);

  const handleLoadedMetadata = useCallback((layer: VideoLayer, event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    const pending = pendingSourceSeekRef.current;
    if (pending && pending.layer === layer) {
      pendingSourceSeekRef.current = null;
      void activateLayer(layer, pending.sourceTimeSec, pending.play);
      return;
    }
    const source = layerSources[layer];
    if (preloadTarget && source?.src === preloadTarget.source.src && layer !== activeLayer) {
      if (Math.abs(video.currentTime - preloadTarget.sourceTimeSec) > 0.015) {
        video.currentTime = preloadTarget.sourceTimeSec;
      }
      return;
    }
    if (layer === activeLayer) {
      setLoadState('ready');
    }
  }, [activateLayer, activeLayer, layerSources, preloadTarget]);

  const handleVideoError = useCallback((layer: VideoLayer) => {
    const failedSource = layerSources[layer];
    const fallbackSource = failedSource ? fallbackSourceForAsset(failedSource.assetId, failedSource.src) : null;
    if (fallbackSource) {
      const pending = pendingSourceSeekRef.current;
      const fallbackTime = pending?.layer === layer
        ? pending.sourceTimeSec
        : layer === activeLayer
          ? locateVirtualPosition(clips, virtualTimeRef.current)?.sourceTimeSec ?? 0
          : preloadTarget?.sourceTimeSec ?? 0;
      pendingSourceSeekRef.current = {
        assetId: fallbackSource.assetId,
        sourceTimeSec: fallbackTime,
        play: pending?.layer === layer ? pending.play : layer === activeLayer && isPlaying,
        layer,
      };
      setLayerSources((current) => (
        layer === 0 ? [fallbackSource, current[1]] : [current[0], fallbackSource]
      ));
      if (layer === activeLayer) {
        setLoadState('loading');
      }
      return;
    }
    if (layer === activeLayer) {
      setLoadState('error');
      setIsPlaying(false);
    }
  }, [activeLayer, clips, fallbackSourceForAsset, isPlaying, layerSources, preloadTarget]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    let frameId = 0;
    const tick = () => {
      syncPlaybackPosition();
      if (!getVideo(activeLayer)?.paused) {
        frameId = requestAnimationFrame(tick);
      }
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [activeLayer, getVideo, isPlaying, syncPlaybackPosition]);

  useEffect(() => {
    const start = locateVirtualPosition(clips, 0);
    const source = sourceForAsset(start?.clip.assetId);
    for (const video of [videoARef.current, videoBRef.current]) {
      video?.pause();
    }
    pendingSourceSeekRef.current = null;
    setActiveLayer(0);
    setLayerSources([source, null]);
    if (start && source) {
      pendingSourceSeekRef.current = {
        assetId: start.clip.assetId,
        sourceTimeSec: start.sourceTimeSec,
        play: false,
        layer: 0,
      };
    }
    updateVirtualTime(0);
    setIsPlaying(false);
    setLoadState(source ? 'loading' : videoSources.length > 0 ? 'error' : 'idle');
  }, [clips, revision, sourceForAsset, updateVirtualTime, videoSources.length]);

  useEffect(() => {
    if (!preloadTarget) {
      return;
    }
    const bufferVideo = getVideo(inactiveLayer);
    const bufferSource = layerSources[inactiveLayer];
    if (bufferVideo && bufferSource?.src === preloadTarget.source.src && bufferVideo.readyState >= MEDIA_HAVE_METADATA) {
      if (Math.abs(bufferVideo.currentTime - preloadTarget.sourceTimeSec) > 0.015) {
        bufferVideo.currentTime = preloadTarget.sourceTimeSec;
      }
      return;
    }
    setLayerSources((current) => (
      current[inactiveLayer]?.src === preloadTarget.source.src
        ? current
        : inactiveLayer === 0 ? [preloadTarget.source, current[1]] : [current[0], preloadTarget.source]
    ));
  }, [getVideo, inactiveLayer, layerSources, preloadTarget]);

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
    const video = getVideo(activeLayer);
    const assetId = sourcePreviewTarget.assetId ?? activeSource?.assetId ?? clips[0]?.assetId;
    if (!assetId || !video) {
      return;
    }
    video.pause();
    setIsPlaying(false);
    seekSource(assetId, sourcePreviewTarget.sourceTimeSec, false);
  }, [activeLayer, activeSource?.assetId, clips, getVideo, seekSource, sourcePreviewTarget]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === frameRef.current);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  return (
    <>
      {layerSources[activeLayer] ? (
        <>
          <div className="video-frame" ref={frameRef}>
            {[0, 1].map((layer) => {
              const typedLayer = layer as VideoLayer;
              const source = layerSources[typedLayer];
              if (!source) {
                return null;
              }
              const active = typedLayer === activeLayer;
              return (
                <video
                  key={`${typedLayer}:${source.src}`}
                  ref={typedLayer === 0 ? videoARef : videoBRef}
                  src={source.src}
                  className={active ? 'video active' : 'video video-buffer'}
                  preload="auto"
                  playsInline
                  aria-hidden={!active}
                  onLoadedMetadata={(event) => handleLoadedMetadata(typedLayer, event)}
                  onCanPlay={() => {
                    if (active) {
                      setLoadState('ready');
                    }
                  }}
                  onWaiting={() => {
                    if (active) {
                      setLoadState('loading');
                    }
                  }}
                  onError={() => handleVideoError(typedLayer)}
                  onPause={() => {
                    if (active) {
                      setIsPlaying(false);
                    }
                  }}
                  onPlay={() => {
                    if (active) {
                      setIsPlaying(true);
                    }
                  }}
                  onEnded={() => {
                    if (active) {
                      setIsPlaying(false);
                    }
                  }}
                  onTimeUpdate={() => {
                    if (active) {
                      syncPlaybackPosition();
                    }
                  }}
                />
              );
            })}
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
            <button className="icon-action secondary" onClick={toggleFullscreen} disabled={loadState !== 'ready'} title={isFullscreen ? 'Exit full screen' : 'Full screen'} aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}>
              {isFullscreen ? <Minimize2 size={16} strokeWidth={1.8} aria-hidden="true" /> : <Maximize2 size={16} strokeWidth={1.8} aria-hidden="true" />}
              <span className="sr-only">{isFullscreen ? 'Exit full screen' : 'Full screen'}</span>
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
              style={{ '--slider-progress': `${sliderProgress}%` } as CSSProperties}
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
