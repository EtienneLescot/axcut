import type { PointerEvent as ReactPointerEvent } from 'react';

export type PointerDragEndReason = 'pointerup' | 'pointercancel' | 'window-blur' | 'document-hidden';

type PointerDragOptions = {
  onMove: (event: PointerEvent) => void;
  onEnd: (reason: PointerDragEndReason, event?: PointerEvent) => void;
};

export function startGlobalPointerDrag(event: ReactPointerEvent<HTMLElement>, options: PointerDragOptions) {
  const target = event.currentTarget;
  const pointerId = event.pointerId;
  let ended = false;

  const cleanup = (reason: PointerDragEndReason, pointerEvent?: PointerEvent) => {
    if (ended) {
      return;
    }
    ended = true;
    globalThis.window.removeEventListener('pointermove', handleMove, true);
    globalThis.window.removeEventListener('pointerup', handlePointerUp, true);
    globalThis.window.removeEventListener('pointercancel', handlePointerCancel, true);
    globalThis.window.removeEventListener('pointerout', handlePointerOut, true);
    globalThis.window.removeEventListener('mouseout', handleMouseOut, true);
    globalThis.window.removeEventListener('blur', handleWindowBlur, true);
    globalThis.document.removeEventListener('visibilitychange', handleVisibilityChange, true);
    try {
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    } catch {
      // Some browsers can throw if the pointer was already implicitly released.
    }
    options.onEnd(reason, pointerEvent);
  };

  const handleMove = (pointerEvent: PointerEvent) => {
    if (pointerEvent.pointerId !== pointerId) {
      return;
    }
    if (pointerEvent.buttons === 0) {
      cleanup('pointerup', pointerEvent);
      return;
    }
    options.onMove(pointerEvent);
  };

  const handlePointerUp = (pointerEvent: PointerEvent) => {
    if (pointerEvent.pointerId !== pointerId) {
      return;
    }
    cleanup('pointerup', pointerEvent);
  };

  const handlePointerCancel = (pointerEvent: PointerEvent) => {
    if (pointerEvent.pointerId !== pointerId) {
      return;
    }
    cleanup('pointercancel', pointerEvent);
  };

  const handlePointerOut = (pointerEvent: PointerEvent) => {
    if (pointerEvent.pointerId === pointerId && pointerEvent.relatedTarget === null) {
      cleanup('pointercancel', pointerEvent);
    }
  };
  const handleMouseOut = (mouseEvent: MouseEvent) => {
    if (mouseEvent.relatedTarget === null) {
      cleanup('pointercancel');
    }
  };
  const handleWindowBlur = () => cleanup('window-blur');
  const handleVisibilityChange = () => {
    if (globalThis.document.visibilityState === 'hidden') {
      cleanup('document-hidden');
    }
  };

  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Window-level listeners below still provide a fallback for older/edge cases.
  }
  globalThis.window.addEventListener('pointermove', handleMove, true);
  globalThis.window.addEventListener('pointerup', handlePointerUp, true);
  globalThis.window.addEventListener('pointercancel', handlePointerCancel, true);
  globalThis.window.addEventListener('pointerout', handlePointerOut, true);
  globalThis.window.addEventListener('mouseout', handleMouseOut, true);
  globalThis.window.addEventListener('blur', handleWindowBlur, true);
  globalThis.document.addEventListener('visibilitychange', handleVisibilityChange, true);

  return () => cleanup('pointercancel');
}
