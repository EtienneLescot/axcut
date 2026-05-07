import type { AxcutClip } from '@axcut/schema';

import { formatSeconds, locateVirtualPosition, totalVirtualDuration } from '../lib/virtual-preview.js';

type TimelinePaneProps = {
  clips: AxcutClip[];
  currentTimeSec: number;
  onSeek: (timeSec: number) => void;
};

export function TimelinePane({ clips, currentTimeSec, onSeek }: TimelinePaneProps) {
  const durationSec = totalVirtualDuration(clips);
  const activePosition = locateVirtualPosition(clips, currentTimeSec);
  const activeClip = activePosition?.clip;
  const total = Math.max(durationSec, 0.001);

  return (
    <section className="timeline-pane panel">
      <div className="timeline-header">
        <div>
          <h2>Timeline</h2>
          <p className="muted">
            {clips.length} clip{clips.length === 1 ? '' : 's'} · {formatSeconds(durationSec)} total
          </p>
        </div>
        <div className="timeline-readout">
          <strong>{formatSeconds(currentTimeSec)}</strong>
          <span className="muted">
            {activePosition ? `Clip ${activePosition.clipIndex + 1}/${clips.length}` : 'No active clip'}
          </span>
        </div>
      </div>

      <div className="timeline-track" aria-label="Virtual timeline">
        {clips.length > 0 ? clips.map((clip) => {
          const width = `${Math.max(3, ((clip.timelineEndSec - clip.timelineStartSec) / total) * 100)}%`;
          const active = activeClip?.id === clip.id;
          return (
            <button
              key={clip.id}
              className={active ? 'timeline-clip active' : 'timeline-clip'}
              style={{ width }}
              title={`${formatSeconds(clip.timelineStartSec)} to ${formatSeconds(clip.timelineEndSec)}`}
              onClick={() => onSeek(clip.timelineStartSec)}
            >
              <span>{formatSeconds(clip.timelineStartSec)}</span>
              <small>{formatSeconds(clip.sourceStartSec)}-{formatSeconds(clip.sourceEndSec)}</small>
            </button>
          );
        }) : <div className="timeline-empty muted">No virtual clips yet.</div>}
      </div>
    </section>
  );
}
