import { useEffect, useState, type CSSProperties } from 'react';
import { deckModeShortcutLabel, shortcutLabel } from '../lib/format';

// First-session hints — three one-shot nudges spread across the first minutes
// of listening: the palette, the visualizer, the deck. Each hint persists its
// own localStorage key at the moment it is shown, so a hint whose turn never
// came (short first session) still gets its one shot on a later launch, and a
// shown hint never repeats. Hints are content, not decoration: they render
// under prefers-reduced-motion too.
//
// Each hint points at a control. If none of its controls is on screen when the
// hint is due (the fullscreen visualizer, the first-launch tour, a sidebar
// scrolled past the control), the hint waits and tries again rather than
// spending its one shot on nothing.

// 'right' sits beside the control, 'below' under it and right-aligned (the
// title bar's buttons are against the window edge), 'center' under it and
// centred.
type HintSide = 'right' | 'below' | 'center';

interface HintTarget {
  find: () => HTMLElement | null;
  side: HintSide;
}

interface FirstRunHint {
  storageKey: string;
  text: () => string;
  targets: HintTarget[];
  delayMs: number;
  durationMs: number;
}

interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface HintBox {
  style: CSSProperties;
  arrow: CSSProperties;
}

const HINT_GAP = 14;
const HINT_EDGE = 8;
const HINT_MAX_WIDTH = 320;
const ARROW = 6;
const RETRY_MS = 5_000;
const RETRIES = 12;

const byAnchor = (name: string) => (): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-newamp-hint-anchor="${name}"]`);
const titleBar = byAnchor('titlebar');

const HINTS: FirstRunHint[] = [
  // Key kept from 1.x so users who already saw the single Ctrl+K tip
  // never see it again. There is no Quick Play button to point at, so this one
  // hangs from the title bar.
  {
    storageKey: 'newamp:firstrun:quickPlayTip',
    text: () => `Press ${shortcutLabel('Mod+K')} to search anything.`,
    targets: [{ find: titleBar, side: 'center' }],
    delayMs: 3_000,
    durationMs: 6_000,
  },
  {
    storageKey: 'newamp:firstrun:fullscreenVizTip',
    text: () => 'Press F for the fullscreen visualizer.',
    targets: [
      { find: () => document.querySelector<HTMLElement>('[data-newamp-open-visualizer]'), side: 'right' },
      { find: titleBar, side: 'center' },
    ],
    delayMs: 90_000,
    durationMs: 7_000,
  },
  {
    storageKey: 'newamp:firstrun:compactDeckTip',
    text: () => `Press ${deckModeShortcutLabel()} to shrink into the deck, and again to come back.`,
    targets: [{ find: byAnchor('deck'), side: 'below' }],
    delayMs: 210_000,
    durationMs: 7_000,
  },
];

// Where the bubble goes, and its pointer. Anchoring to an edge (right, or the
// centre line) rather than a corner means the bubble's width never has to be
// measured to keep it on screen.
function placeHint(anchor: AnchorRect, side: HintSide, view: { width: number; height: number }): HintBox {
  const up: CSSProperties = {
    top: -ARROW,
    borderWidth: `0 ${ARROW}px ${ARROW}px`,
    borderBottomColor: 'var(--accent-dim)',
  };
  const room = (space: number): number => Math.max(0, Math.min(HINT_MAX_WIDTH, space));
  if (side === 'below') {
    const right = Math.max(HINT_EDGE, view.width - anchor.right);
    return {
      style: { top: anchor.bottom + HINT_GAP, right, maxWidth: room(view.width - right - HINT_EDGE) },
      arrow: { ...up, right: Math.max(4, (anchor.right - anchor.left) / 2 - ARROW) },
    };
  }
  if (side === 'center') {
    const center = (anchor.left + anchor.right) / 2;
    return {
      style: {
        top: anchor.bottom + HINT_GAP,
        left: center,
        transform: 'translateX(-50%)',
        maxWidth: room(2 * (Math.min(center, view.width - center) - HINT_EDGE)),
      },
      arrow: { ...up, left: '50%', marginLeft: -ARROW },
    };
  }
  const left = anchor.right + HINT_GAP;
  return {
    style: {
      top: (anchor.top + anchor.bottom) / 2,
      left,
      transform: 'translateY(-50%)',
      maxWidth: room(view.width - left - HINT_EDGE),
    },
    arrow: {
      left: -ARROW,
      top: '50%',
      marginTop: -ARROW,
      borderWidth: `${ARROW}px ${ARROW}px ${ARROW}px 0`,
      borderRightColor: 'var(--accent-dim)',
    },
  };
}

// A control can be in the DOM and still not be there to point at: hidden along
// with the chrome behind the fullscreen visualizer, scrolled out of the
// sidebar and under the transport, or behind a dialog. The point at its
// centre has to land on it.
function onScreen(el: HTMLElement, view: { width: number; height: number }): boolean {
  if (window.getComputedStyle(el).visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const x = (rect.left + rect.right) / 2;
  const y = (rect.top + rect.bottom) / 2;
  if (x < 0 || y < 0 || x > view.width || y > view.height) return false;
  const hit = document.elementFromPoint(x, y);
  return !!hit && el.contains(hit);
}

function hintBox(hint: FirstRunHint): HintBox | null {
  if (document.querySelector('[data-newamp-first-launch-tutorial]')) return null;
  const view = { width: window.innerWidth, height: window.innerHeight };
  for (const target of hint.targets) {
    const el = target.find();
    if (el && onScreen(el, view)) return placeHint(el.getBoundingClientRect(), target.side, view);
  }
  return null;
}

export function FirstRunHintsBody(): JSX.Element | null {
  const [active, setActive] = useState<{ hint: FirstRunHint; text: string } | null>(null);
  const [box, setBox] = useState<HintBox | null>(null);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const timers: number[] = [];
    for (const hint of HINTS) {
      if (window.localStorage.getItem(hint.storageKey) === 'shown') continue;
      const attempt = (retriesLeft: number): void => {
        const placed = hintBox(hint);
        if (!placed) {
          if (retriesLeft > 0) timers.push(window.setTimeout(() => attempt(retriesLeft - 1), RETRY_MS));
          return;
        }
        const text = hint.text();
        window.localStorage.setItem(hint.storageKey, 'shown');
        setBox(placed);
        setActive({ hint, text });
        timers.push(
          window.setTimeout(() => {
            setActive((current) => (current?.text === text ? null : current));
          }, hint.durationMs),
        );
      };
      timers.push(window.setTimeout(() => attempt(RETRIES), hint.delayMs));
    }
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);

  // A resize moves the control, so the hint follows it while it is up.
  useEffect(() => {
    if (!active) return undefined;
    const follow = (): void => setBox(hintBox(active.hint));
    window.addEventListener('resize', follow);
    return () => window.removeEventListener('resize', follow);
  }, [active]);

  // The entry fade is a transition from the first painted frame, not the
  // stylesheet's keyframe, which is written for a tip centred at the bottom.
  useEffect(() => {
    setEntered(false);
    if (!active) return undefined;
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  if (!active || !box) return null;
  return (
    <div
      className="first-run-tip"
      role="status"
      data-newamp-first-run-hint
      style={{
        position: 'fixed',
        left: 'auto',
        right: 'auto',
        bottom: 'auto',
        transform: 'none',
        borderRadius: 12,
        animation: 'none',
        opacity: entered ? 1 : 0,
        transition: 'opacity 220ms ease-out',
        ...box.style,
      }}
    >
      {active.text}
      <span aria-hidden style={{ position: 'absolute', width: 0, height: 0, border: '0 solid transparent', ...box.arrow }} />
    </div>
  );
}
