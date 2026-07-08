// Deck router. Reads the persisted deck-skin preference, resizes the window
// to match the skin's natural aspect ratio, and renders the chosen skin
// component. Each skin owns its own shape — resizing the window never adds
// empty letterbox padding because the window matches the deck.

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { api, winctl } from '../lib/api';
import { captureDeckSnapshot } from '../lib/deck-snapshot';
import { Camera } from './Icons';
import { ClassicBentoDeck } from './decks/ClassicBentoDeck';
import { RecordPlayerDeck } from './decks/RecordPlayerDeck';
import { JukeboxDeck } from './decks/JukeboxDeck';
import { CassetteDeck } from './decks/CassetteDeck';
import { DiscmanDeck } from './decks/DiscmanDeck';
import { RetroTvDeck } from './decks/RetroTvDeck';
import { WinampClassicDeck, WinampIndustrialDeck } from './decks/WinampClassicDeck';
import { DECK_SKINS, findDeck, type DeckProps, type DeckSkin } from './decks/types';

const DECK_SKIN_KEY = 'newamp:deck:skin';
const DECK_SKIN_SCHEMA_KEY = 'newamp:deck:skinSchema';
const DECK_SKIN_SCHEMA = '2';
const VIZ_EXPANDED_KEY = 'newamp:deck:vizExpanded';

function loadInitialSkin(): DeckSkin {
  if (typeof window === 'undefined') return 'bento';
  if (window.localStorage.getItem(DECK_SKIN_SCHEMA_KEY) !== DECK_SKIN_SCHEMA) {
    window.localStorage.setItem(DECK_SKIN_KEY, 'bento');
    window.localStorage.setItem(DECK_SKIN_SCHEMA_KEY, DECK_SKIN_SCHEMA);
    return 'bento';
  }
  const raw = window.localStorage.getItem(DECK_SKIN_KEY);
  if (raw && DECK_SKINS.some((skin) => skin.id === raw)) return raw as DeckSkin;
  return 'bento';
}

function loadInitialVizExpanded(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(VIZ_EXPANDED_KEY) === '1';
}

export function CompactPlayer(): JSX.Element {
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const volume = usePlayerStore((s) => s.volume);
  const mode = usePlayerStore((s) => s.mode);
  const alwaysOnTop = usePlayerStore((s) => s.alwaysOnTop);
  const setMode = usePlayerStore((s) => s.setMode);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const seek = usePlayerStore((s) => s.seek);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const setCompactMode = usePlayerStore((s) => s.setCompactMode);
  const setAlwaysOnTop = usePlayerStore((s) => s.setAlwaysOnTop);
  const setFullscreenViz = usePlayerStore((s) => s.setFullscreenViz);

  const [deckSkin, setDeckSkin] = useState<DeckSkin>(() => loadInitialSkin());
  const [vizExpanded, setVizExpanded] = useState<boolean>(() => loadInitialVizExpanded());
  // Shared chrome overlay state: the camera affordance fades in when the
  // pointer is over the window (or the button is keyboard-focused), and hides
  // itself entirely while the shutter fires so it never photobombs its own shot.
  const [chromeHover, setChromeHover] = useState(false);
  const [snapshotFocus, setSnapshotFocus] = useState(false);
  const [shutterBusy, setShutterBusy] = useState(false);

  const artUrl = useMemo(
    () => (current ? api.getArtUrl(current.id) : null),
    [current?.id],
  );

  // Resize the OS window to match the chosen deck's natural size whenever the
  // skin changes. setMinimumSize is dropped so the user is never letterboxed.
  useEffect(() => {
    const deck = findDeck(deckSkin);
    void winctl.setCompact(true, deck.size);
  }, [deckSkin]);

  function handlePickSkin(skin: DeckSkin): void {
    setDeckSkin(skin);
    window.localStorage.setItem(DECK_SKIN_KEY, skin);
    window.localStorage.setItem(DECK_SKIN_SCHEMA_KEY, DECK_SKIN_SCHEMA);
  }

  function handleToggleVizExpanded(): void {
    setVizExpanded((value) => {
      const next = !value;
      window.localStorage.setItem(VIZ_EXPANDED_KEY, next ? '1' : '0');
      return next;
    });
  }

  // Deck Snapshot: hide the overlay chrome, let the compositor paint two
  // frames so the hidden button is really gone from the capture, then run the
  // capture → polaroid → clipboard/save flow (src/lib/deck-snapshot.ts).
  async function handleSnapshot(): Promise<void> {
    if (shutterBusy) return;
    setShutterBusy(true);
    try {
      await new Promise<void>((resolveFrames) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolveFrames())),
      );
      await captureDeckSnapshot({
        title: current?.title ?? '',
        artist: current?.artist ?? '',
        skinLabel: findDeck(deckSkin).label,
      });
    } finally {
      setShutterBusy(false);
    }
  }

  // Ctrl+Shift+S — snapshot hotkey while the compact deck is up. The listener
  // lives and dies with CompactPlayer, so it can never fire in the full app.
  const snapshotRef = useRef<() => void>(() => undefined);
  snapshotRef.current = () => void handleSnapshot();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
      if (event.code !== 'KeyS' && event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      snapshotRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const deckProps: DeckProps = {
    track: current,
    isPlaying,
    currentTime,
    duration,
    volume,
    mode,
    alwaysOnTop,
    artUrl,
    deckSkin,
    vizExpanded,
    onTogglePlay: togglePlay,
    onStop: () => usePlayerStore.getState().engine.stop(),
    onNext: () => void next(),
    onPrev: () => void prev(),
    onSeek: seek,
    onSetVolume: (v) => void setVolume(v),
    onSetMode: setMode,
    onSetAlwaysOnTop: setAlwaysOnTop,
    onExitDeck: () => setCompactMode(false),
    onMinimize: () => void winctl.minimize(),
    onClose: () => void winctl.close(),
    onPickSkin: handlePickSkin,
    onToggleVizExpanded: handleToggleVizExpanded,
    onOpenFullscreenViz: () => {
      setCompactMode(false);
      setFullscreenViz(true);
    },
  };

  let deckEl: JSX.Element;
  switch (deckSkin) {
    case 'winamp-classic':
      deckEl = <WinampClassicDeck {...deckProps} />;
      break;
    case 'winamp-industrial':
      deckEl = <WinampIndustrialDeck {...deckProps} />;
      break;
    case 'record-player':
      deckEl = <RecordPlayerDeck {...deckProps} />;
      break;
    case 'jukebox':
      deckEl = <JukeboxDeck {...deckProps} />;
      break;
    case 'cassette':
      deckEl = <CassetteDeck {...deckProps} />;
      break;
    case 'discman':
      deckEl = <DiscmanDeck {...deckProps} />;
      break;
    case 'retro-tv':
      deckEl = <RetroTvDeck {...deckProps} />;
      break;
    case 'bento':
    default:
      deckEl = <ClassicBentoDeck {...deckProps} />;
  }

  const snapshotVisible = !shutterBusy && (chromeHover || snapshotFocus);

  // Shared chrome overlay: one Camera affordance rendered above whichever deck
  // is active, so every registered skin gets Deck Snapshot for free. The
  // wrapper carries no -webkit-app-region of its own — each deck keeps its
  // titlebar-drag/nodrag zones — and the button is titlebar-nodrag so clicking
  // it never fights the frameless window drag. It sits just below the decks'
  // titlebar controls and only fades in on hover/focus, matching the decks'
  // quiet-until-touched chrome.
  return (
    <div
      style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}
      onMouseEnter={() => setChromeHover(true)}
      onMouseLeave={() => setChromeHover(false)}
      data-newamp-compact-deck-root
    >
      {deckEl}
      <button
        type="button"
        className="pxbtn titlebar-nodrag"
        data-newamp-deck-snapshot
        title="Snapshot this deck as a polaroid (Ctrl+Shift+S)"
        aria-label="Snapshot deck as polaroid"
        onClick={() => void handleSnapshot()}
        onFocus={() => setSnapshotFocus(true)}
        onBlur={() => setSnapshotFocus(false)}
        disabled={shutterBusy}
        style={{
          position: 'absolute',
          top: 30,
          right: 8,
          zIndex: 40,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: snapshotVisible ? 1 : 0,
          pointerEvents: snapshotVisible ? 'auto' : 'none',
          transition: 'opacity var(--dur-base, 200ms) ease',
        }}
      >
        <Camera size={12} />
      </button>
    </div>
  );
}
