// The palette's global chords live here, in the startup chunk; the palette
// itself (results, previews, its own search) loads the first time it opens.
// Nothing about it is needed to start playing music, and it is one of the
// larger components in the app.
import { lazy, Suspense, useEffect, useState } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';

const QuickPlayPaletteBody = lazy(() =>
  import('./QuickPlayPalette').then((module) => ({ default: module.QuickPlayPaletteBody })),
);

export function QuickPlayPalette(): JSX.Element | null {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && (key === 'k' || key === 'j')) {
        event.preventDefault();
        setOpen((next) => !next);
      } else if ((event.ctrlKey || event.metaKey) && key === 'm' && !event.altKey && !event.shiftKey) {
        // Ctrl+M — deck mode. Documented in the README and taught by the
        // first-launch tour; this listener is the app's global chord home.
        // One-way by design: the deck view unmounts this component, so exit
        // stays on the deck's own controls.
        event.preventDefault();
        usePlayerStore.getState().setCompactMode(true);
        setOpen(false);
      } else if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('newamp-smoke') !== '1') return undefined;
    const target = window as unknown as {
      __newampSmoke?: {
        seek?: (seconds: number) => void;
        openQuickPlay?: () => void;
        setFullscreenVisualizer?: (on: boolean) => void;
      };
    };
    const previous = target.__newampSmoke;
    target.__newampSmoke = {
      ...previous,
      openQuickPlay: () => setOpen(true),
    };
    return () => {
      if (previous) target.__newampSmoke = previous;
      else delete target.__newampSmoke;
    };
  }, []);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <QuickPlayPaletteBody open onClose={() => setOpen(false)} />
    </Suspense>
  );
}
