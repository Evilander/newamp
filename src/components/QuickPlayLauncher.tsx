// The palette's global chords live here, in the startup chunk; the palette
// itself (results, previews, its own search) loads the first time it opens.
// Nothing about it is needed to start playing music, and it is one of the
// larger components in the app.
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { isDeckModeChord, isLibrarySearchChord } from '@shared/keyboard-shortcuts';
import { api } from '../lib/api';
import { usePlayerStore } from '../store/usePlayerStore';

const QuickPlayPaletteBody = lazy(() =>
  import('./QuickPlayPalette').then((module) => ({ default: module.QuickPlayPaletteBody })),
);

const LIBRARY_SEARCH_INPUT = '[data-newamp-library-search-command] input';
const LIBRARY_SEARCH_WAIT_MS = 3000;
// The dialog that sits above the palette and owns the keyboard. Other
// aria-modal surfaces (the table columns popover) are not in the way.
const TOUR_OPEN = '[data-newamp-first-launch-tutorial]';
// setCompactMode applies the main process's answer when it lands, so a second
// flip inside that round trip would be overwritten by the first one's reply.
const DECK_TOGGLE_GAP_MS = 250;
const OPEN_EVENT = 'newamp:open-quick-play';

/** Opens the palette from a button, with the same refusals as its chord. */
export function openQuickPlay(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

// Library is a lazy view, so coming from another one the input is not in the
// DOM yet. Watch for it rather than guessing how long the chunk takes.
function focusLibrarySearch(): void {
  const focusNow = (): boolean => {
    const input = document.querySelector<HTMLInputElement>(LIBRARY_SEARCH_INPUT);
    if (!input) return false;
    input.focus();
    input.select();
    return true;
  };
  usePlayerStore.getState().setView('library');
  if (focusNow()) return;
  const observer = new MutationObserver(() => {
    if (!focusNow()) return;
    observer.disconnect();
    window.clearTimeout(giveUp);
  });
  const giveUp = window.setTimeout(() => observer.disconnect(), LIBRARY_SEARCH_WAIT_MS);
  observer.observe(document.body, { childList: true, subtree: true });
}

export function QuickPlayPalette(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    let lastDeckToggle = -Infinity;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      const key = event.key.toLowerCase();
      // Cmd on a Mac, where Ctrl+K and Ctrl+J are the text fields' kill-line
      // and newline.
      const command = api.platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey || event.metaKey;
      if (command && (key === 'k' || key === 'j')) {
        // Closing is always allowed; opening is not over the first-launch tour,
        // where the palette would sit hidden behind it and take focus out of it.
        if (!openRef.current && document.querySelector(TOUR_OPEN)) return;
        event.preventDefault();
        setOpen((next) => !next);
      } else if (isDeckModeChord(event, api.platform)) {
        // Deck mode, both ways: this listener stays mounted in the deck, so
        // the same chord that shrinks the window also restores it.
        event.preventDefault();
        // A held chord would flip the window on every key repeat.
        if (event.repeat || event.timeStamp - lastDeckToggle < DECK_TOGGLE_GAP_MS) return;
        lastDeckToggle = event.timeStamp;
        const store = usePlayerStore.getState();
        store.setCompactMode(!store.compactMode);
        setOpen(false);
      } else if (isLibrarySearchChord(event, api.platform)) {
        // Only where the Library search is on screen to land in: not over the
        // tour, the deck, or the fullscreen visualizer, which keeps its own
        // keys.
        const store = usePlayerStore.getState();
        if (openRef.current || store.compactMode || store.fullscreenViz || document.querySelector(TOUR_OPEN)) return;
        event.preventDefault();
        focusLibrarySearch();
      } else if (event.key === 'Escape') {
        setOpen(false);
      }
    }
    function onOpenRequest(): void {
      if (!document.querySelector(TOUR_OPEN)) setOpen(true);
    }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener(OPEN_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener(OPEN_EVENT, onOpenRequest);
    };
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
  // Its own stacking context above the fullscreen visualizer (z-90), which
  // the palette's own z-80 would otherwise sit under. Outside .app-chrome it
  // no longer inherits that shell's no-select rule, so it carries its own.
  return (
    <div className="fixed z-[100] select-none">
      <Suspense fallback={null}>
        <QuickPlayPaletteBody open onClose={() => setOpen(false)} />
      </Suspense>
    </div>
  );
}
