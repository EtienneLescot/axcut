import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { AxcutClip, AxcutDocument, AxcutWord } from '@axcut/schema';
import { Trash2 } from 'lucide-react';

import { formatSeconds, selectWordRange } from '../lib/virtual-preview.js';

type CurrentTranscriptViewProps = {
  document: AxcutDocument | null;
  busy: boolean;
  sourceDurationSec: number;
  cueSourceTimeSec: number | null;
  onSeekSourceTime: (sourceTimeSec: number) => void;
  onReplaceTimeline: (intervals: Array<{ startSec: number; endSec: number }>, reason: string) => void;
};

type TranscriptRun = {
  id: string;
  kind: 'kept' | 'cut';
  words: AxcutWord[];
  startSec: number;
  endSec: number;
};

const SILENCE_TOKEN_THRESHOLD_SEC = 0.5;

export function CurrentTranscriptView({ document, busy, sourceDurationSec, cueSourceTimeSec, onSeekSourceTime, onReplaceTimeline }: CurrentTranscriptViewProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const pendingCaretWordIdRef = useRef<string | null>(null);

  const transcriptWords = useMemo(() => (
    [...(document?.transcript?.words ?? [])].sort((a, b) => a.startSec - b.startSec)
  ), [document?.transcript?.words]);
  const sourceDuration = useMemo(() => (
    Math.max(
      sourceDurationSec,
      ...(document?.timeline.clips.map((clip) => clip.sourceEndSec) ?? [0]),
      ...(document?.transcript?.segments.map((segment) => segment.endSec) ?? [0]),
      ...transcriptWords.map((word) => word.endSec),
    )
  ), [document?.timeline.clips, document?.transcript?.segments, sourceDurationSec, transcriptWords]);
  const keptIntervals = useMemo(
    () => normalizeIntervals(sourceDuration, timelineIntervals(document?.timeline.clips ?? [])),
    [document?.timeline.clips, sourceDuration],
  );
  const displayTranscript = useMemo(
    () => buildDisplayTranscriptWords(document, keptIntervals, sourceDuration),
    [document, keptIntervals, sourceDuration],
  );
  const words = displayTranscript.words;
  const keptWords = displayTranscript.keptWordIds;
  const runs = useMemo(() => buildTranscriptRuns(words, keptWords), [keptWords, words]);
  const cueWordId = useMemo(
    () => findCueWordId(words, cueSourceTimeSec),
    [cueSourceTimeSec, words],
  );

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

  const seekCaretSourceTime = useCallback(() => {
    const selection = globalThis.getSelection();
    const editor = editorRef.current;
    if (!selection || !selection.isCollapsed || !editor || !editor.contains(selection.anchorNode)) {
      return;
    }
    const sourceTimeSec = sourceTimeFromCaret(editor, selection.anchorNode, selection.anchorOffset, words);
    if (sourceTimeSec === null) {
      return;
    }
    onSeekSourceTime(sourceTimeSec);
  }, [onSeekSourceTime, words]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const targetElement = event.target instanceof Element ? event.target : null;
    if (targetElement?.closest('button')) {
      return;
    }
    const sourceTimeSec = sourceTimeFromPointer(event.target, event.clientX, words);
    if (sourceTimeSec !== null) {
      onSeekSourceTime(sourceTimeSec);
      return;
    }
    requestAnimationFrame(seekCaretSourceTime);
  }, [onSeekSourceTime, seekCaretSourceTime, words]);

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
        onKeyUp={seekCaretSourceTime}
        onPaste={handlePaste}
        onPointerUp={handlePointerUp}
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
                  cue={word.id === cueWordId}
                />
              ))}
              <button
                className="transcript-cut-delete"
                type="button"
                contentEditable={false}
                onClick={(event) => {
                  event.stopPropagation();
                  restoreCutRun(run);
                }}
                onPointerUp={(event) => event.stopPropagation()}
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
                  cue={word.id === cueWordId}
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
  cue,
}: {
  word: AxcutWord;
  dropped: boolean;
  cue: boolean;
}) {
  return (
    <span
      className={[
        'transcript-word',
        isSilenceWord(word) ? 'silence' : '',
        dropped ? 'cut' : 'kept',
        cue ? 'cue' : '',
      ].filter(Boolean).join(' ')}
      data-word-id={word.id}
      data-start-sec={word.startSec}
      data-end-sec={word.endSec}
      title={isSilenceWord(word) ? `${formatSeconds(word.startSec)}-${formatSeconds(word.endSec)}` : undefined}
    >
      {word.text}
      {' '}
    </span>
  );
}

export function findCueWordId(words: AxcutWord[], cueSourceTimeSec: number | null): string | null {
  if (cueSourceTimeSec === null) {
    return null;
  }
  const exactSilence = words.find((word) => (
    isSilenceWord(word)
    && cueSourceTimeSec >= word.startSec
    && cueSourceTimeSec < word.endSec
  ));
  if (exactSilence) {
    return exactSilence.id;
  }

  let previousWordId: string | null = null;
  const spokenWords = words
    .filter((word) => !isSilenceWord(word))
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  for (const [index, word] of spokenWords.entries()) {
    if (cueSourceTimeSec < word.startSec) {
      return previousWordId;
    }
    const isLast = index === spokenWords.length - 1;
    if (cueSourceTimeSec >= word.startSec && (cueSourceTimeSec < word.endSec || (isLast && cueSourceTimeSec <= word.endSec))) {
      return word.id;
    }
    previousWordId = word.id;
  }

  return previousWordId;
}

function buildDisplayTranscriptWords(
  document: AxcutDocument | null,
  keptIntervals: Array<{ startSec: number; endSec: number }>,
  sourceDuration: number,
): { words: AxcutWord[]; keptWordIds: Set<string> } {
  const transcript = document?.transcript;
  if (!transcript) {
    return { words: [], keptWordIds: new Set() };
  }

  const keptWordIds = new Set<string>();
  const displayWords: AxcutWord[] = [];
  const transcriptWords = [...transcript.words].sort((a, b) => a.startSec - b.startSec);
  for (const word of transcriptWords) {
    displayWords.push(word);
    if (intervalOverlaps(word, keptIntervals)) {
      keptWordIds.add(word.id);
    }
  }

  const silenceWords: AxcutWord[] = [];
  for (const [silenceIndex, silence] of collectSilenceIntervals(transcriptWords, transcript.segments, sourceDuration).entries()) {
    for (const [partIndex, part] of splitIntervalByKept(silence.startSec, silence.endSec, keptIntervals).entries()) {
      if (part.endSec - part.startSec < SILENCE_TOKEN_THRESHOLD_SEC) {
        continue;
      }
      const silenceWord = createSilenceWord(`silence_${silenceIndex}`, partIndex, part.startSec, part.endSec);
      silenceWords.push(silenceWord);
      displayWords.push(silenceWord);
      if (part.kept) {
        keptWordIds.add(silenceWord.id);
      }
    }
  }

  const cutIntervals = invertIntervals(keptIntervals, sourceDuration);
  for (const [index, cut] of cutIntervals.entries()) {
    if (cut.endSec - cut.startSec < SILENCE_TOKEN_THRESHOLD_SEC) {
      continue;
    }
    const overlapsTranscriptContent = [...transcriptWords, ...silenceWords]
      .some((word) => intervalOverlaps(word, [cut]));
    if (overlapsTranscriptContent) {
      continue;
    }
    displayWords.push(createSilenceWord('implicit_cut', index, cut.startSec, cut.endSec));
  }

  return {
    words: displayWords.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec),
    keptWordIds,
  };
}

function createSilenceWord(segmentId: string, index: number, startSec: number, endSec: number): AxcutWord {
  const durationSec = Math.max(0, endSec - startSec);
  return {
    id: `silence_${segmentId}_${index}_${startSec.toFixed(3)}_${endSec.toFixed(3)}`,
    segmentId,
    startSec,
    endSec,
    text: `(${durationSec.toFixed(1)}s)`,
  };
}

function collectSilenceIntervals(
  words: AxcutWord[],
  segments: Array<{ kind: string; startSec: number; endSec: number }>,
  sourceDuration: number,
): Array<{ startSec: number; endSec: number }> {
  const candidates: Array<{ startSec: number; endSec: number }> = [];
  for (const segment of segments) {
    if (segment.kind === 'silence') {
      candidates.push({ startSec: segment.startSec, endSec: segment.endSec });
    }
  }
  for (let index = 0; index < words.length - 1; index += 1) {
    const current = words[index];
    const next = words[index + 1];
    if (next.startSec > current.endSec) {
      candidates.push({ startSec: current.endSec, endSec: next.startSec });
    }
  }
  const firstWord = words[0];
  const lastWord = words.at(-1);
  if (firstWord && firstWord.startSec > 0) {
    candidates.push({ startSec: 0, endSec: firstWord.startSec });
  }
  if (lastWord && sourceDuration > lastWord.endSec) {
    candidates.push({ startSec: lastWord.endSec, endSec: sourceDuration });
  }
  return normalizeIntervals(sourceDuration, candidates)
    .filter((interval) => interval.endSec - interval.startSec >= SILENCE_TOKEN_THRESHOLD_SEC);
}

function splitIntervalByKept(
  startSec: number,
  endSec: number,
  keptIntervals: Array<{ startSec: number; endSec: number }>,
): Array<{ startSec: number; endSec: number; kept: boolean }> {
  const boundaries = new Set([startSec, endSec]);
  for (const interval of keptIntervals) {
    if (interval.endSec <= startSec || interval.startSec >= endSec) {
      continue;
    }
    boundaries.add(Math.max(startSec, interval.startSec));
    boundaries.add(Math.min(endSec, interval.endSec));
  }
  const sortedBoundaries = [...boundaries].sort((a, b) => a - b);
  const parts: Array<{ startSec: number; endSec: number; kept: boolean }> = [];
  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const partStart = sortedBoundaries[index];
    const partEnd = sortedBoundaries[index + 1];
    if (partEnd - partStart < SILENCE_TOKEN_THRESHOLD_SEC) {
      continue;
    }
    const midpoint = partStart + ((partEnd - partStart) / 2);
    parts.push({
      startSec: partStart,
      endSec: partEnd,
      kept: keptIntervals.some((interval) => midpoint >= interval.startSec && midpoint < interval.endSec),
    });
  }
  return parts;
}

function invertIntervals(
  intervals: Array<{ startSec: number; endSec: number }>,
  durationSec: number,
): Array<{ startSec: number; endSec: number }> {
  const normalized = normalizeIntervals(durationSec, intervals);
  const output: Array<{ startSec: number; endSec: number }> = [];
  let cursor = 0;
  for (const interval of normalized) {
    if (interval.startSec > cursor) {
      output.push({ startSec: cursor, endSec: interval.startSec });
    }
    cursor = Math.max(cursor, interval.endSec);
  }
  if (durationSec > cursor) {
    output.push({ startSec: cursor, endSec: durationSec });
  }
  return output;
}

function intervalOverlaps(
  range: { startSec: number; endSec: number },
  intervals: Array<{ startSec: number; endSec: number }>,
): boolean {
  return intervals.some((interval) => range.endSec > interval.startSec && range.startSec < interval.endSec);
}

function isSilenceWord(word: AxcutWord): boolean {
  return word.id.startsWith('silence_');
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

export function sourceTimeFromCaret(
  editor: HTMLElement,
  node: Node | null,
  offset: number,
  words: AxcutWord[],
): number | null {
  const wordElement = closestWordElement(node);
  if (wordElement?.dataset.wordId) {
    const word = words.find((item) => item.id === wordElement.dataset.wordId);
    if (!word) {
      return null;
    }
    return interpolateWordSourceTime(word, node, offset);
  }

  const wordId = findSelectionWordId(editor, node, offset, 'forward')
    ?? findSelectionWordId(editor, node, offset, 'backward');
  const word = words.find((item) => item.id === wordId);
  return word ? word.startSec : null;
}

function sourceTimeFromPointer(target: EventTarget | null, clientX: number, words: AxcutWord[]): number | null {
  const targetElement = target instanceof Element ? target : null;
  const wordElement = targetElement?.closest<HTMLElement>('[data-word-id]');
  if (!wordElement?.dataset.wordId) {
    return null;
  }
  const word = words.find((item) => item.id === wordElement.dataset.wordId);
  if (!word) {
    return null;
  }
  const rect = wordElement.getBoundingClientRect();
  const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
  return word.startSec + (Math.max(0, word.endSec - word.startSec) * ratio);
}

function interpolateWordSourceTime(word: AxcutWord, node: Node | null, offset: number): number {
  const durationSec = Math.max(0, word.endSec - word.startSec);
  if (durationSec <= 0 || node?.nodeType !== Node.TEXT_NODE) {
    return word.startSec;
  }
  const textLength = Math.max(1, word.text.length);
  const ratio = Math.max(0, Math.min(1, offset / textLength));
  return word.startSec + (durationSec * ratio);
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
