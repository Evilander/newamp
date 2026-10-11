import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { keyboardOpener, pickFocusRestoreTarget, scrollKeepsWheel } from './visualizer-input';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusQuietly(element: HTMLElement): void {
  element.focus({ preventScroll: true });
}

/** What has focus right now when it is a control the keyboard put it on (see keyboardOpener). */
export function focusedByKeyboard(): HTMLElement | null {
  const active = document.activeElement;
  return keyboardOpener(active instanceof HTMLElement ? active : null, document.body);
}

/**
 * Focus for the visualizer's popovers: move into the open one, then back to
 * what opened it (or `fallback`) when it closes. A button opened with the
 * mouse is not an opener to return to; focus goes to `fallback` instead.
 * Not a trap — the toolbar stays reachable — so a click on another control
 * keeps its own focus. `open` is whichever popover is showing, or null; a
 * change swaps focus over.
 */
export function usePopoverFocus(
  panel: RefObject<HTMLElement>,
  open: string | null,
  fallback: RefObject<HTMLElement>,
): void {
  useLayoutEffect(() => {
    const element = panel.current;
    if (!open || !element) return undefined;
    const opener = focusedByKeyboard();
    // The pressed entry first (the current preset, the current quality), then
    // whatever comes first.
    focusQuietly(
      element.querySelector<HTMLElement>('[aria-pressed="true"]') ??
        element.querySelector<HTMLElement>(FOCUSABLE) ??
        element,
    );
    return () => {
      pickFocusRestoreTarget({
        opener,
        active: document.activeElement,
        body: document.body,
        panel: element,
        fallback: fallback.current,
      })?.focus({ preventScroll: true });
    };
  }, [open, panel, fallback]);
}

/**
 * Focus for the stage itself: take it when the visualizer opens, so Tab starts
 * inside it, and hand it back to the control that opened it on close, but only
 * when that control had keyboard focus (see keyboardOpener).
 */
export function useStageFocus(stage: RefObject<HTMLElement>): void {
  const pendingRestore = useRef(0);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return undefined;
    window.clearTimeout(pendingRestore.current);
    const opener = focusedByKeyboard();
    focusQuietly(element);
    return () => {
      if (!opener) return;
      // The window's chrome is still hidden while this unmounts; wait for it.
      pendingRestore.current = window.setTimeout(() => {
        const now = document.activeElement;
        if (opener.isConnected && (!now || now === document.body)) focusQuietly(opener);
      }, 0);
    };
  }, [stage]);
}

/**
 * A popover or menu that scrolls keeps the wheel. The stage's own wheel handler
 * turns every wheel event into a volume change, so a list taller than the
 * window could not be scrolled. `key` re-binds when a different panel takes
 * over the same ref.
 */
export function useScrollKeepsWheel(panel: RefObject<HTMLElement>, key: unknown = null): void {
  useEffect(() => {
    const element = panel.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent): void => {
      if (scrollKeepsWheel(element)) event.stopPropagation();
    };
    element.addEventListener('wheel', onWheel);
    return () => element.removeEventListener('wheel', onWheel);
  }, [panel, key]);
}
