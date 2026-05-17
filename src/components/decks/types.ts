// Deck skins for the compact "always on top" player. Each skin reshapes the
// window to its own native size, so the user never sees a generic empty border
// around the skin chrome.

import type { Track } from '@shared/types';

export type DeckSkin = 'bento' | 'record-player' | 'jukebox' | 'cassette';

export const DECK_SKINS: {
  id: DeckSkin;
  label: string;
  shortLabel: string;
  tagline: string;
  size: { width: number; height: number };
}[] = [
  { id: 'bento',         label: 'Windowshade',   shortLabel: 'BAR',  tagline: 'Slim Winamp-style bar',      size: { width: 620, height: 116 } },
  { id: 'record-player', label: 'Record Player', shortLabel: 'VIN',  tagline: 'Spinning vinyl + tonearm',   size: { width: 540, height: 540 } },
  { id: 'jukebox',       label: 'Jukebox',       shortLabel: 'JUKE', tagline: 'Wurlitzer arch + chrome',    size: { width: 420, height: 560 } },
  { id: 'cassette',      label: 'Cassette Deck', shortLabel: 'TAPE', tagline: 'Twin spools, magnetic tape', size: { width: 760, height: 320 } },
];

export interface DeckProps {
  track: Track | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  mode: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one';
  alwaysOnTop: boolean;
  artUrl: string | null;
  /** Skin picked by user; passed in so each skin can show a skin-select chip. */
  deckSkin: DeckSkin;
  /** Whether the visualizer should expand to take the full art area. */
  vizExpanded: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSeek: (t: number) => void;
  onSetVolume: (v: number) => void;
  onSetMode: (m: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one') => void;
  onSetAlwaysOnTop: (on: boolean) => void;
  onExitDeck: () => void;
  onMinimize: () => void;
  onClose: () => void;
  onPickSkin: (skin: DeckSkin) => void;
  onToggleVizExpanded: () => void;
  onOpenFullscreenViz: () => void;
}

export function findDeck(skin: DeckSkin): typeof DECK_SKINS[number] {
  return DECK_SKINS.find((d) => d.id === skin) ?? DECK_SKINS[0]!;
}
