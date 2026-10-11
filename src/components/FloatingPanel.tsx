// A small window inside the app window: drag it by the title bar (or move it
// with the arrow keys from the grip), and it stays on screen, remembers where
// it was left, and closes with Esc. It is not modal: the page behind it stays
// live, which is the point of a panel you edit colours from. Mount it outside
// .app-chrome (see FloatingPanelHost) so it also sits over the fullscreen
// visualizer.
import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import {
  PANEL_MARGIN,
  PANEL_TOP_LIMIT,
  defaultPanelPosition,
  loadPanelPosition,
  nudgePanel,
  placeInViewport,
  savePanelPosition,
  type PanelPosition,
  type PanelSize,
} from '../lib/floating-panel';
import { usePopoverFocus } from './usePopoverFocus';

// Used for the first frame only; the real height is measured before paint.
const HEIGHT_GUESS = 520;

export interface FloatingPanelProps {
  /** Names the saved position and the data attribute. */
  id: string;
  title: string;
  width?: number;
  /** Esc and the close button. */
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}

function viewportSize(): PanelSize {
  return { width: window.innerWidth, height: window.innerHeight };
}

// Kept under the title bar; see PANEL_TOP_LIMIT.
const fitToWindow = (at: PanelPosition, size: PanelSize): PanelPosition =>
  placeInViewport(at, size, viewportSize(), PANEL_MARGIN, PANEL_TOP_LIMIT);

export function FloatingPanel({ id, title, width = 380, onClose, footer, children }: FloatingPanelProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const noFallback = useRef<HTMLElement>(null);
  // Where the panel was put; what is drawn is that spot fitted to the window as it is now.
  const wanted = useRef<PanelPosition | null>(null);
  const [shown, setShown] = useState<PanelPosition>(() => {
    const size = { width, height: HEIGHT_GUESS };
    const saved = loadPanelPosition(id);
    wanted.current = saved ?? defaultPanelPosition(size, viewportSize());
    return fitToWindow(wanted.current, size);
  });
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const drag = useRef<{ pointer: number; x: number; y: number; origin: PanelPosition } | null>(null);

  usePopoverFocus(rootRef, 'open', noFallback);

  function measure(): PanelSize {
    const root = rootRef.current;
    return { width: root?.offsetWidth ?? width, height: root?.offsetHeight ?? HEIGHT_GUESS };
  }

  function put(next: PanelPosition, remember: boolean): void {
    const fitted = fitToWindow(next, measure());
    wanted.current = fitted;
    setShown(fitted);
    if (remember) savePanelPosition(id, fitted);
  }

  // Fit it to the window once it has its real size, and again when the window
  // or the panel's own height changes (a longer list, a prompt in the footer).
  // The spot it was put at is kept, so a window that grows back returns it.
  useLayoutEffect(() => {
    const refit = (): void => {
      if (!wanted.current) return;
      const fitted = fitToWindow(wanted.current, measure());
      setShown((current) => (current.left === fitted.left && current.top === fitted.top ? current : fitted));
    };
    refit();
    window.addEventListener('resize', refit);
    const observer = typeof ResizeObserver === 'function' && rootRef.current ? new ResizeObserver(refit) : null;
    if (observer && rootRef.current) observer.observe(rootRef.current);
    return () => {
      window.removeEventListener('resize', refit);
      observer?.disconnect();
    };
    // measure reads refs and props that only matter through the observer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.floating-panel-close')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, origin: shownRef.current };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    put({ left: active.origin.left + event.clientX - active.x, top: active.origin.top + event.clientY - active.y }, false);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (wanted.current) savePanelPosition(id, wanted.current);
  }

  function onGripKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    const next = nudgePanel(shownRef.current, event.key, event.shiftKey);
    if (!next) return;
    // The arrows move the panel; they are not for the player's own arrow keys behind it.
    event.preventDefault();
    event.stopPropagation();
    put(next, true);
  }

  // Esc closes this panel and nothing else: the fullscreen visualizer's own
  // Esc handler leaves a key from outside its stage alone, and stopping the
  // event here keeps the app-wide handler from exiting the visualizer too.
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }

  return (
    <div
      ref={rootRef}
      className="floating-panel"
      role="dialog"
      aria-label={title}
      aria-modal="false"
      tabIndex={-1}
      data-newamp-floating-panel={id}
      style={{ left: shown.left, top: shown.top, width }}
      onKeyDown={onKeyDown}
    >
      <div
        className="floating-panel-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <button
          type="button"
          className="floating-panel-grip"
          aria-label={`Move ${title}`}
          title="Drag the title bar to move, or use the arrow keys here"
          onKeyDown={onGripKeyDown}
        >
          <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
            <path d="M2 2h2M6 2h2M2 7h2M6 7h2M2 12h2M6 12h2" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
          </svg>
        </button>
        <span className="floating-panel-title">{title}</span>
        <button type="button" className="floating-panel-close" aria-label={`Close ${title}`} title="Close (Esc)" onClick={onClose}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
          </svg>
        </button>
      </div>
      <div className="floating-panel-body">{children}</div>
      {footer && <div className="floating-panel-foot">{footer}</div>}
    </div>
  );
}
