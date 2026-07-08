import { useEffect, useState } from 'react';

// First-session hints — three one-shot nudges spread across the first minutes
// of listening: the palette, the visualizer, the deck. Each hint persists its
// own localStorage key at the moment it is shown, so a hint whose turn never
// came (short first session) still gets its one shot on a later launch, and a
// shown hint never repeats. Hints are content, not decoration: they render
// under prefers-reduced-motion too — the CSS entry animation is what a
// reduced-motion media query suppresses, not the tip itself.

interface FirstRunHint {
  storageKey: string;
  text: string;
  delayMs: number;
  durationMs: number;
}

const HINTS: FirstRunHint[] = [
  // Key kept from 1.x so users who already saw the single Ctrl+K tip
  // never see it again.
  { storageKey: 'newamp:firstrun:quickPlayTip', text: 'Press Ctrl+K to search anything.', delayMs: 3_000, durationMs: 6_000 },
  { storageKey: 'newamp:firstrun:fullscreenVizTip', text: 'Press F for the fullscreen visualizer.', delayMs: 90_000, durationMs: 7_000 },
  { storageKey: 'newamp:firstrun:compactDeckTip', text: 'Press Ctrl+M to shrink into the deck.', delayMs: 210_000, durationMs: 7_000 },
];

export function FirstRunHints(): JSX.Element | null {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const timers: number[] = [];
    for (const hint of HINTS) {
      if (window.localStorage.getItem(hint.storageKey) === 'shown') continue;
      timers.push(
        window.setTimeout(() => {
          window.localStorage.setItem(hint.storageKey, 'shown');
          setMessage(hint.text);
          timers.push(
            window.setTimeout(() => {
              setMessage((current) => (current === hint.text ? null : current));
            }, hint.durationMs),
          );
        }, hint.delayMs),
      );
    }
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);

  if (!message) return null;
  return (
    <div className="first-run-tip" role="status">
      {message}
    </div>
  );
}
