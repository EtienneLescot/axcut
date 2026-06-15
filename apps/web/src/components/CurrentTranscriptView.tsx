import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AxcutClip, AxcutDocument, AxcutWord } from '@axcut/schema';
import { Trash2 } from 'lucide-react';

import { formatSeconds, keptWordIdSet, selectWordRange } from '../lib/virtual-preview.js';

type CurrentTranscriptViewProps = {
  document: AxcutDocument | null;
  busy: boolean;
  sourceDurationSec: number;
  onReplaceTimeline: (intervals: Array<{ startSec: number; endSec: number }>, reason: string) => void;
};

type TranscriptRun = {
  id: string;
  kind: 'kept' | 'cut';
  words: AxcutWord[];
  startSec: number;
  endSec: number;
};

export function CurrentTranscriptView({ document, busy, sourceDurationSec, onReplaceTimeline }: CurrentTranscriptViewProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const pendingCaretWordIdRef = useRef<string | null>(null);

  const words = useMemo(() => (
    [...(document?.transcript?.words ?? [])].sort((a, b) => a.startSec - b.startSec)
  ), [document?.transcript?.words]);
  const keptWords = useMemo(() => keptWordIdSet(document?.timeline.clips ?? []), [document?.timeline.clips]);
  const runs = useMemo(() => buildTranscriptRuns(words, keptWords), [keptWords, words]);
  const sourceDuration = useMemo(() => (
    Math.max(
      sourceDurationSec,
      ...(document?.timeline.clips.map((clip) => clip.sourceEndSec) ?? [0]),
      ...words.map((word) => word.endSec),
    )
  ), [document?.timeline.clips, sourceDurationSec, words]);

  useLayoutEffect(() => {
    const wordId = pendingCaretWordIdRef.current;
    if (!wordId) {
      return;
    }
    pendingCaretWordIdRef.current = null;
    restoreCaretBeforeWord(editorRef.current, wordId);
  }, [runs]);

  const replaceTimelineFromCutRange = useCallback((range: { startSec: number; endSec: number }, reason: string) => {
    if (!document) {
      return;
    }
    onReplaceTimeline(subtractInterval(timelineIntervals(document.timeline.clips), range), reason);
  }, [document, onReplaceTimeline]);

  const cutWordRange = useCallback((rangeWords: AxcutWord[]) => {
    if (busy || rangeWords.length === 0) {
      return;
    }
    const keptRangeWords = rangeWords.filter((word) => keptWords.has(word.id));
    if (keptRangeWords.length === 0) {
      return;
    }
    pendingCaretWordIdRef.current = keptRangeWords[0].id;
    const startSec = Math.min(...keptRangeWords.map((word) => word.startSec));
    const endSec = Math.max(...keptRangeWords.map((word) => word.endSec));
    replaceTimelineFromCutRange(
      { startSec, endSec },
      `Cut transcript selection ${formatSeconds(startSec)}-${formatSeconds(endSec)}.`,
    );
  }, [busy, keptWords, replaceTimelineFromCutRange]);

  const restoreCutRun = useCallback((run: TranscriptRun) => {
    if (busy || !document) {
      return;
    }
    const intervals = normalizeIntervals(sourceDuration, [
      ...timelineIntervals(document.timeline.clips),
      { startSec: run.startSec, endSec: run.endSec },
    ]);
    onReplaceTimeline(
      intervals,
      `Deleted cut ${formatSeconds(run.startSec)}-${formatSeconds(run.endSec)} from the transcript view.`,
    );
  }, [busy, document, onReplaceTimeline, sourceDuration]);

  const cutNativeSelection = useCallback((direction: 'backward' | 'forward') => {
    const selection = globalThis.getSelection();
    const editor = editorRef.current;
    if (!selection || !editor) {
      return false;
    }
    if (!editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) {
      return false;
    }
    if (selection.isCollapsed) {
      const wordId = findCollapsedDeletionWordId(editor, selection.anchorNode, selection.anchorOffset, direction);
      const word = words.find((item) => item.id === wordId);
      if (!word) {
        return false;
      }
      cutWordRange([word]);
      return true;
    }
    const anchorId = findSelectionWordId(editor, selection.anchorNode, selection.anchorOffset, 'forward')
      ?? findSelectionWordId(editor, selection.anchorNode, selection.anchorOffset, 'backward');
    const focusId = findSelectionWordId(editor, selection.focusNode, selection.focusOffset, 'backward')
      ?? findSelectionWordId(editor, selection.focusNode, selection.focusOffset, 'forward');
    const range = selectWordRange(words, anchorId, focusId);
    if (!range) {
      return false;
    }
    cutWordRange(range.words);
    return true;
  }, [cutWordRange, words]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') {
      return;
    }
    event.preventDefault();
    cutNativeSelection(event.key === 'Backspace' ? 'backward' : 'forward');
  }, [cutNativeSelection]);

  const handleBeforeInput = useCallback((event: FormEvent<HTMLDivElement>) => {
    const inputEvent = event.nativeEvent as InputEvent;
    if (inputEvent.inputType.startsWith('delete')) {
      event.preventDefault();
      cutNativeSelection(inputEvent.inputType === 'deleteContentForward' ? 'forward' : 'backward');
      return;
    }
    if (inputEvent.inputType === 'insertText' || inputEvent.inputType === 'insertFromPaste') {
      event.preventDefault();
    }
  }, [cutNativeSelection]);

  const handlePaste = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
  }, []);

  if (!document?.transcript) {
    return (
      <div className="transcript-empty muted">
        No transcript is available yet.
      </div>
    );
  }

  if (words.length === 0) {
    return (
      <div className="transcript-empty muted">
        Transcript is empty.
      </div>
    );
  }

  return (
    <div className="transcript-projection-wrap">
      <div
        ref={editorRef}
        className="transcript-projection"
        role="textbox"
        tabIndex={0}
        contentEditable={!busy}
        suppressContentEditableWarning
        spellCheck={false}
        aria-label="Current transcript projection"
        aria-multiline="true"
        onBeforeInput={handleBeforeInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      >
        {runs.map((run) => (
          run.kind === 'cut' ? (
            <span
              key={run.id}
              className="transcript-cut-run"
              title={`Cut ${formatSeconds(run.startSec)}-${formatSeconds(run.endSec)}`}
            >
              {run.words.map((word) => (
                <TranscriptWord
                  key={word.id}
                  word={word}
                  dropped
                />
              ))}
              <button
                className="transcript-cut-delete"
                type="button"
                contentEditable={false}
                onClick={() => restoreCutRun(run)}
                disabled={busy}
                title="Delete cut"
                aria-label={`Delete cut ${formatSeconds(run.startSec)}-${formatSeconds(run.endSec)}`}
              >
                <Trash2 size={12} strokeWidth={1.9} aria-hidden="true" />
              </button>
            </span>
          ) : (
            <span key={run.id} className="transcript-kept-run">
              {run.words.map((word) => (
                <TranscriptWord
                  key={word.id}
                  word={word}
                  dropped={false}
                />
              ))}
            </span>
          )
        ))}
      </div>
    </div>
  );
}

function TranscriptWord({
  word,
  dropped,
}: {
  word: AxcutWord;
  dropped: boolean;
}) {
  return (
    <span
      className={[
        'transcript-word',
        dropped ? 'cut' : 'kept',
      ].filter(Boolean).join(' ')}
      data-word-id={word.id}
    >
      {word.text}
      {' '}
    </span>
  );
}

function buildTranscriptRuns(words: AxcutWord[], keptWords: Set<string>): TranscriptRun[] {
  const runs: TranscriptRun[] = [];
  for (const word of words) {
    const kind: TranscriptRun['kind'] = keptWords.has(word.id) ? 'kept' : 'cut';
    const previous = runs.at(-1);
    if (previous && previous.kind === kind && word.startSec - previous.endSec <= 1) {
      previous.words.push(word);
      previous.endSec = Math.max(previous.endSec, word.endSec);
      continue;
    }
    runs.push({
      id: `${kind}_${runs.length + 1}_${word.id}`,
      kind,
      words: [word],
      startSec: word.startSec,
      endSec: word.endSec,
    });
  }
  return runs;
}

function findWordId(node: Node | null): string | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>('[data-word-id]')?.dataset.wordId ?? null;
}

function findCollapsedDeletionWordId(
  editor: HTMLElement,
  node: Node | null,
  offset: number,
  direction: 'backward' | 'forward',
): string | null {
  const directWord = closestWordElement(node);
  if (directWord) {
    const textLength = node?.textContent?.length ?? 0;
    if (node?.nodeType === Node.TEXT_NODE) {
      if (direction === 'backward' && offset <= 0) {
        return adjacentWordId(editor, directWord, 'backward') ?? directWord.dataset.wordId ?? null;
      }
      if (direction === 'forward' && offset >= textLength) {
        return adjacentWordId(editor, directWord, 'forward') ?? directWord.dataset.wordId ?? null;
      }
    }
    return directWord.dataset.wordId ?? null;
  }
  if (!node) {
    return null;
  }

  const wordNodes = Array.from(editor.querySelectorAll<HTMLElement>('[data-word-id]'));
  if (wordNodes.length === 0) {
    return null;
  }

  const boundaryNode = node instanceof Element ? node : node.parentElement;
  if (!boundaryNode) {
    return null;
  }

  const childNodes = Array.from(boundaryNode.childNodes);
  const candidateNodes = direction === 'backward'
    ? childNodes.slice(0, offset).reverse()
    : childNodes.slice(offset);
  for (const candidate of candidateNodes) {
    const wordId = findWordId(candidate) ?? findDescendantWordId(candidate);
    if (wordId) {
      return wordId;
    }
  }

  const range = globalThis.document.createRange();
  range.setStart(editor, 0);
  range.setEnd(node, clampRangeOffset(node, offset));
  const wordsBefore = wordNodes.filter((wordNode) => {
    const comparison = range.comparePoint(wordNode, 0);
    return comparison <= 0;
  });
  if (direction === 'backward') {
    return wordsBefore.at(-1)?.dataset.wordId ?? null;
  }
  return wordNodes.find((wordNode) => !wordsBefore.includes(wordNode))?.dataset.wordId ?? null;
}

function findSelectionWordId(
  editor: HTMLElement,
  node: Node | null,
  offset: number,
  direction: 'backward' | 'forward',
): string | null {
  return findWordId(node) ?? findCollapsedDeletionWordId(editor, node, offset, direction);
}

function findDescendantWordId(node: Node): string | null {
  if (node instanceof HTMLElement && node.dataset.wordId) {
    return node.dataset.wordId;
  }
  return node instanceof Element
    ? node.querySelector<HTMLElement>('[data-word-id]')?.dataset.wordId ?? null
    : null;
}

function closestWordElement(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>('[data-word-id]') ?? null;
}

function adjacentWordId(editor: HTMLElement, wordElement: HTMLElement, direction: 'backward' | 'forward'): string | null {
  const wordNodes = Array.from(editor.querySelectorAll<HTMLElement>('[data-word-id]'));
  const index = wordNodes.indexOf(wordElement);
  if (index < 0) {
    return null;
  }
  return wordNodes[index + (direction === 'backward' ? -1 : 1)]?.dataset.wordId ?? null;
}

function clampRangeOffset(node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return Math.max(0, Math.min(offset, node.textContent?.length ?? 0));
  }
  return Math.max(0, Math.min(offset, node.childNodes.length));
}

function restoreCaretBeforeWord(editor: HTMLElement | null, wordId: string) {
  const wordElement = editor?.querySelector<HTMLElement>(`[data-word-id="${CSS.escape(wordId)}"]`);
  if (!editor || !wordElement) {
    return;
  }
  editor.focus();
  const range = globalThis.document.createRange();
  range.setStartBefore(wordElement);
  range.collapse(true);
  const selection = globalThis.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function timelineIntervals(clips: AxcutClip[]): Array<{ startSec: number; endSec: number }> {
  return clips.map((clip) => ({ startSec: clip.sourceStartSec, endSec: clip.sourceEndSec }));
}

function subtractInterval(
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
  return normalizeIntervals(Number.POSITIVE_INFINITY, output);
}

function normalizeIntervals(durationSec: number, intervals: Array<{ startSec: number; endSec: number }>): Array<{ startSec: number; endSec: number }> {
  const bounded = intervals
    .map((interval) => ({
      startSec: Math.max(0, Math.min(durationSec, interval.startSec)),
      endSec: Math.max(0, Math.min(durationSec, interval.endSec)),
    }))
    .filter((interval) => interval.endSec > interval.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const merged: Array<{ startSec: number; endSec: number }> = [];
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
