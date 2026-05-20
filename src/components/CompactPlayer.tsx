// Deck router. Reads the persisted deck-skin preference, resizes the window
// to match the skin's natural aspect ratio, and renders the chosen skin
// component. Each skin owns its own shape — resizing the window never adds
// empty letterbox padding because the window matches the deck.

import { useEffect, useMemo, useState } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { api, winctl } from '../lib/api';
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

  switch (deckSkin) {
    case 'winamp-classic':
      return <WinampClassicDeck {...deckProps} />;
    case 'winamp-industrial':
      return <WinampIndustrialDeck {...deckProps} />;
    case 'record-player':
      return <RecordPlayerDeck {...deckProps} />;
    case 'jukebox':
      return <JukeboxDeck {...deckProps} />;
    case 'cassette':
      return <CassetteDeck {...deckProps} />;
    case 'discman':
      return <DiscmanDeck {...deckProps} />;
    case 'retro-tv':
      return <RetroTvDeck {...deckProps} />;
    case 'bento':
    default:
      return <ClassicBentoDeck {...deckProps} />;
  }
}
