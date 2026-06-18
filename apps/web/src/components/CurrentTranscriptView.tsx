import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { normalizeSkipRanges, type AxcutAsset, type AxcutClip, type AxcutDocument, type AxcutTranscript, type AxcutWord } from '@axcut/schema';
import { Trash2 } from 'lucide-react';

import { formatSeconds, selectWordRange } from '../lib/virtual-preview.js';

type CurrentTranscriptViewProps = {
  document: AxcutDocument | null;
  busy: boolean;
  cuePosition: { assetId: string; clipId: string; sourceTimeSec: number } | null;
  onSeekSourceTime: (sourceTimeSec: number, assetId?: string, clipId?: string) => void;
  onAddSkipRange: (assetId: string, startSec: number, endSec: number, reason: string) => void;
  onRemoveSkipRange: (skipId: string) => void;
};

type ProjectedWord = AxcutWord & {
  timelineClipId: string;
  skipId?: string;
};

type ResolvedWord = {
  word: AxcutWord & Partial<ProjectedWord>;
  sourceTimeSec: number;
};

type TranscriptRun = {
  id: string;
  kind: 'kept' | 'skip';
  words: ProjectedWord[];
  startSec: number;
  endSec: number;
  skipId?: string;
};

type TranscriptClipProjection = {
  clip: AxcutClip;
  asset: AxcutAsset | null;
  transcript: AxcutTranscript | null;
  words: ProjectedWord[];
  keptWordIds: Set<string>;
};

const SILENCE_TOKEN_THRESHOLD_SEC = 0.5;

export function CurrentTranscriptView({ document, busy, cuePosition, onSeekSourceTime, onAddSkipRange, onRemoveSkipRange }: CurrentTranscriptViewProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const pendingCaretWordIdRef = useRef<string | null>(null);

  const clipProjections = useMemo(() => buildClipTranscriptProjections(document), [document]);
  const words = useMemo(() => clipProjections.flatMap((projection) => projection.words), [clipProjections]);
  const keptWords = useMemo(() => new Set(clipProjections.flatMap((projection) => Array.from(projection.keptWordIds))), [clipProjections]);
  const runsByClipId = useMemo(() => (
    new Map(clipProjections.map((projection) => [
      projection.clip.id,
      buildTranscriptRuns(projection.words, projection.keptWordIds),
    ]))
  ), [clipProjections]);
  const cueWordId = useMemo(
    () => findCueWordId(words, cuePosition),
    [cuePosition, words],
  );

  useLayoutEffect(() => {
    const wordId = pendingCaretWordIdRef.current;
    if (!wordId) {
      return;
    }
    pendingCaretWordIdRef.current = null;
    restoreCaretBeforeWord(editorRef.current, wordId);
  }, [runsByClipId]);

  const skipWordRange = useCallback((rangeWords: AxcutWord[]) => {
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
    const assetId = keptRangeWords[0].assetId;
    if (!assetId || keptRangeWords.some((word) => word.assetId !== assetId)) {
      return;
    }
    onAddSkipRange(
      assetId,
      startSec,
      endSec,
      `Skip transcript selection ${formatSeconds(startSec)}-${formatSeconds(endSec)} from ${assetId}.`,
    );
  }, [busy, keptWords, onAddSkipRange]);

  const removeSkipRun = useCallback((run: TranscriptRun) => {
    if (busy || !run.skipId) {
      return;
    }
    onRemoveSkipRange(run.skipId);
  }, [busy, onRemoveSkipRange]);

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
      skipWordRange([word]);
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
    skipWordRange(range.words);
    return true;
  }, [skipWordRange, words]);

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
    const resolved = wordFromCaret(editor, selection.anchorNode, selection.anchorOffset, words);
    if (!resolved) {
      return;
    }
    onSeekSourceTime(resolved.sourceTimeSec, resolved.word.assetId, resolved.word.timelineClipId);
  }, [onSeekSourceTime, words]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const targetElement = event.target instanceof Element ? event.target : null;
    if (targetElement?.closest('button')) {
      return;
    }
    const resolved = wordFromPointer(event.target, event.clientX, words);
    if (resolved) {
      onSeekSourceTime(resolved.sourceTimeSec, resolved.word.assetId, resolved.word.timelineClipId);
      return;
    }
    requestAnimationFrame(seekCaretSourceTime);
  }, [onSeekSourceTime, seekCaretSourceTime, words]);

  if (!document || document.timeline.clips.length === 0) {
    return (
      <div className="transcript-empty muted">
        No timeline clips yet.
      </div>
    );
  }

  if (words.length === 0) {
    return (
      <div className="transcript-empty muted">
        No transcript is available for timeline clips yet.
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
        {clipProjections.map((projection, index) => (
          <span key={projection.clip.id} className="transcript-clip-block">
            <span className="transcript-clip-header" contentEditable={false}>
              <span className="transcript-clip-vignette" aria-hidden="true">{index + 1}</span>
              <span>
                <strong>{projection.asset?.label ?? projection.clip.assetId}</strong>
                <small className="muted">
                  Clip {index + 1} · {formatSeconds(projection.clip.timelineStartSec)}-{formatSeconds(projection.clip.timelineEndSec)}
                </small>
              </span>
            </span>
            {(runsByClipId.get(projection.clip.id) ?? []).map((run) => (
              run.kind === 'skip' ? (
                <span
                  key={run.id}
                  className="transcript-cut-run"
                  title={`Skip ${formatSeconds(run.startSec)}-${formatSeconds(run.endSec)}`}
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
                      removeSkipRun(run);
                    }}
                    onPointerUp={(event) => event.stopPropagation()}
                    disabled={busy || !run.skipId}
                    title="Remove skip"
                    aria-label={`Remove skip ${formatSeconds(run.startSec)}-${formatSeconds(run.endSec)}`}
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
          </span>
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

function buildClipTranscriptProjections(document: AxcutDocument | null): TranscriptClipProjection[] {
  if (!document) {
    return [];
  }
  const clips = [...document.timeline.clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
  const normalizedSkipRanges = normalizeSkipRanges(document.timeline.skipRanges);
  return clips.map((clip) => {
    const transcript = document.transcripts.find((item) => item.assetId === clip.assetId)
      ?? (document.transcript?.assetId === clip.assetId ? document.transcript : null);
    const asset = document.assets.find((item) => item.id === clip.assetId) ?? null;
    if (!transcript) {
      return {
        clip,
        asset,
        transcript: null,
        words: [],
        keptWordIds: new Set<string>(),
      };
    }
    const clipSkips = normalizedSkipRanges.filter((skip) => (
      skip.assetId === clip.assetId
      && skip.endSec > clip.sourceStartSec
      && skip.startSec < clip.sourceEndSec
    ));
    const clipWords = transcript.words
      .filter((word) => word.endSec > clip.sourceStartSec && word.startSec < clip.sourceEndSec)
      .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)
      .map((word): ProjectedWord => ({
        ...word,
        id: `${clip.id}:${word.id}`,
        assetId: word.assetId ?? transcript.assetId,
        timelineClipId: clip.id,
        skipId: matchingSkipId(word, clipSkips),
        startSec: Math.max(clip.sourceStartSec, word.startSec),
        endSec: Math.min(clip.sourceEndSec, word.endSec),
    }));
    const silenceWords = collectClipSilenceIntervals(clipWords, transcript.segments, clip.sourceStartSec, clip.sourceEndSec)
      .map((silence, index) => {
        const word = createSilenceWord(`${clip.id}_silence`, index, silence.startSec, silence.endSec, clip.assetId, clip.id);
        return { ...word, skipId: matchingSkipId(word, clipSkips) };
      });
    const words = [...clipWords, ...silenceWords].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
    return {
      clip,
      asset,
      transcript,
      words,
      keptWordIds: new Set(words.filter((word) => !word.skipId).map((word) => word.id)),
    };
  });
}

function matchingSkipId(word: Pick<AxcutWord, 'startSec' | 'endSec'>, skips: AxcutDocument['timeline']['skipRanges']): string | undefined {
  return skips.find((skip) => word.endSec > skip.startSec && word.startSec < skip.endSec)?.id;
}

export function findCueWordId(words: AxcutWord[], cuePosition: { assetId: string; clipId?: string; sourceTimeSec: number } | number | null): string | null {
  if (cuePosition === null) {
    return null;
  }
  const assetId = typeof cuePosition === 'number' ? undefined : cuePosition.assetId;
  const clipId = typeof cuePosition === 'number' ? undefined : cuePosition.clipId;
  const sourceTimeSec = typeof cuePosition === 'number' ? cuePosition : cuePosition.sourceTimeSec;
  const assetWords = words.filter((word) => (
    (!assetId || word.assetId === assetId)
    && (!clipId || (word as Partial<ProjectedWord>).timelineClipId === clipId)
  ));
  const exactSilence = words.find((word) => (
    isSilenceWord(word)
    && (!assetId || word.assetId === assetId)
    && (!clipId || (word as Partial<ProjectedWord>).timelineClipId === clipId)
    && sourceTimeSec >= word.startSec
    && sourceTimeSec < word.endSec
  ));
  if (exactSilence) {
    return exactSilence.id;
  }

  let previousWordId: string | null = null;
  const spokenWords = assetWords
    .filter((word) => !isSilenceWord(word))
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  for (const [index, word] of spokenWords.entries()) {
    if (sourceTimeSec < word.startSec) {
      return previousWordId;
    }
    const isLast = index === spokenWords.length - 1;
    if (sourceTimeSec >= word.startSec && (sourceTimeSec < word.endSec || (isLast && sourceTimeSec <= word.endSec))) {
      return word.id;
    }
    previousWordId = word.id;
  }

  return previousWordId;
}

function createSilenceWord(segmentId: string, index: number, startSec: number, endSec: number, assetId: string, timelineClipId: string): ProjectedWord {
  const durationSec = Math.max(0, endSec - startSec);
  return {
    id: `silence_${segmentId}_${index}_${startSec.toFixed(3)}_${endSec.toFixed(3)}`,
    assetId,
    segmentId,
    startSec,
    endSec,
    text: `(${durationSec.toFixed(1)}s)`,
    timelineClipId,
  };
}

function collectClipSilenceIntervals(
  words: AxcutWord[],
  segments: Array<{ kind: string; startSec: number; endSec: number }>,
  clipStartSec: number,
  clipEndSec: number,
): Array<{ startSec: number; endSec: number }> {
  const candidates: Array<{ startSec: number; endSec: number }> = [];
  for (const segment of segments) {
    if (segment.kind === 'silence' && segment.endSec > clipStartSec && segment.startSec < clipEndSec) {
      candidates.push({
        startSec: Math.max(clipStartSec, segment.startSec),
        endSec: Math.min(clipEndSec, segment.endSec),
      });
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
  if (firstWord && firstWord.startSec > clipStartSec) {
    candidates.push({ startSec: clipStartSec, endSec: firstWord.startSec });
  }
  if (lastWord && clipEndSec > lastWord.endSec) {
    candidates.push({ startSec: lastWord.endSec, endSec: clipEndSec });
  }
  if (!firstWord && !lastWord) {
    candidates.push({ startSec: clipStartSec, endSec: clipEndSec });
  }
  return normalizeIntervals(clipEndSec, candidates)
    .map((interval) => ({ startSec: Math.max(clipStartSec, interval.startSec), endSec: Math.min(clipEndSec, interval.endSec) }))
    .filter((interval) => interval.endSec - interval.startSec >= SILENCE_TOKEN_THRESHOLD_SEC);
}

function isSilenceWord(word: AxcutWord): boolean {
  return word.id.startsWith('silence_');
}

function buildTranscriptRuns(words: ProjectedWord[], keptWords: Set<string>): TranscriptRun[] {
  const runs: TranscriptRun[] = [];
  for (const word of words) {
    const kind: TranscriptRun['kind'] = keptWords.has(word.id) ? 'kept' : 'skip';
    const previous = runs.at(-1);
    if (previous && previous.kind === kind && previous.skipId === word.skipId && word.startSec - previous.endSec <= 1) {
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
      skipId: word.skipId,
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
  const resolved = wordFromCaret(editor, node, offset, words);
  return resolved ? resolved.sourceTimeSec : null;
}

function wordFromCaret(
  editor: HTMLElement,
  node: Node | null,
  offset: number,
  words: AxcutWord[],
): ResolvedWord | null {
  const wordElement = closestWordElement(node);
  if (wordElement?.dataset.wordId) {
    const word = words.find((item) => item.id === wordElement.dataset.wordId);
    if (!word) {
      return null;
    }
    return { word, sourceTimeSec: interpolateWordSourceTime(word, node, offset) };
  }

  const wordId = findSelectionWordId(editor, node, offset, 'forward')
    ?? findSelectionWordId(editor, node, offset, 'backward');
  const word = words.find((item) => item.id === wordId);
  return word ? { word, sourceTimeSec: word.startSec } : null;
}

function wordFromPointer(target: EventTarget | null, clientX: number, words: AxcutWord[]): ResolvedWord | null {
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
  return { word, sourceTimeSec: word.startSec + (Math.max(0, word.endSec - word.startSec) * ratio) };
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
