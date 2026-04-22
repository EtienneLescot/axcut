import { useMemo, useState } from 'react';
import type { AxcutDocument } from '@axcut/schema';

import { keptWordIdSet, selectWordRange } from '../lib/virtual-preview.js';

type TranscriptEditorProps = {
  document: AxcutDocument;
  busy: boolean;
  onDropWordRange: (startWordId: string, endWordId: string) => void;
  onRestoreTimeline: () => void;
};

export function TranscriptEditor({ document, busy, onDropWordRange, onRestoreTimeline }: TranscriptEditorProps) {
  const [anchorWordId, setAnchorWordId] = useState<string | null>(null);
  const [focusWordId, setFocusWordId] = useState<string | null>(null);

  const transcript = document.transcript;
  const wordMap = useMemo(
    () => new Map((transcript?.words ?? []).map((word) => [word.id, word])),
    [transcript?.words],
  );
  const keptWords = useMemo(() => keptWordIdSet(document.timeline.clips), [document.timeline.clips]);
  const selectedRange = useMemo(
    () => selectWordRange(transcript?.words ?? [], anchorWordId, focusWordId),
    [anchorWordId, focusWordId, transcript?.words],
  );

  if (!transcript) {
    return (
      <div className="panel">
        <h2>Transcript</h2>
        <p className="muted">Transcript will appear after ingest completes.</p>
      </div>
    );
  }

  return (
    <div className="panel transcript-panel">
      <div className="panel-header transcript-toolbar">
        <div>
          <h2>Transcript</h2>
          <p className="muted">Click a word, then shift-click or click another word to define a cut range.</p>
        </div>
        <div className="toolbar-actions">
          <button
            onClick={() => {
              if (selectedRange) {
                onDropWordRange(selectedRange.startWordId, selectedRange.endWordId);
                setAnchorWordId(null);
                setFocusWordId(null);
              }
            }}
            disabled={busy || !selectedRange}
          >
            Cut selection
          </button>
          <button
            className="secondary-button"
            onClick={() => {
              setAnchorWordId(null);
              setFocusWordId(null);
            }}
            disabled={busy || !selectedRange}
          >
            Clear selection
          </button>
          <button className="secondary-button" onClick={onRestoreTimeline} disabled={busy}>
            Restore full timeline
          </button>
        </div>
      </div>

      {selectedRange ? (
        <div className="selection-summary">
          <strong>Selected:</strong> {selectedRange.text}
        </div>
      ) : null}

      <div className="transcript">
        {transcript.segments.slice(0, 200).map((segment) => (
          <div key={segment.id} className={`segment ${segment.kind}`}>
            <strong>{segment.startSec.toFixed(2)} - {segment.endSec.toFixed(2)}</strong>
            {segment.kind === 'silence' ? (
              <p className="muted">[silence]</p>
            ) : (
              <div className="word-stream">
                {segment.wordIds.map((wordId) => {
                  const word = wordMap.get(wordId);
                  if (!word) {
                    return null;
                  }
                  const isSelected = selectedRange?.words.some((item) => item.id === word.id) ?? false;
                  const isKept = keptWords.has(word.id);
                  const classes = [
                    'word-chip',
                    isSelected ? 'selected' : '',
                    isKept ? 'kept' : 'dropped',
                  ].filter(Boolean).join(' ');
                  return (
                    <button
                      key={word.id}
                      className={classes}
                      onClick={(event) => {
                        if (!anchorWordId) {
                          setAnchorWordId(word.id);
                          setFocusWordId(word.id);
                          return;
                        }
                        if (event.shiftKey || anchorWordId === focusWordId) {
                          setFocusWordId(word.id);
                          return;
                        }
                        setAnchorWordId(word.id);
                        setFocusWordId(word.id);
                      }}
                    >
                      {word.text}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
