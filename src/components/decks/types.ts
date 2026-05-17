// Deck skins for the compact "always on top" player. Each skin reshapes the
// window to its own native size, so the user never sees a generic empty border
// around the skin chrome.

import type { Track } from '@shared/types';

export type DeckSkin =
  | 'bento'
  | 'winamp-classic'
  | 'winamp-industrial'
  | 'record-player'
  | 'jukebox'
  | 'cassette'
  | 'hotdog'
  | 'retro-tv';

export const DECK_SKINS: {
  id: DeckSkin;
  label: string;
  shortLabel: string;
  tagline: string;
  size: { width: number; height: number };
}[] = [
  { id: 'bento',             label: 'Windowshade',      shortLabel: 'BAR',  tagline: 'Slim fixed-proportion deck bar', size: { width: 820, height: 112 } },
  { id: 'winamp-classic',    label: 'Winamp Classic',   shortLabel: 'W2X',  tagline: '275x116 Winamp 2 main window, scaled 2x', size: { width: 550, height: 232 } },
  { id: 'winamp-industrial', label: 'Winamp Industrial',shortLabel: 'IND',  tagline: 'Dark pixel-skin throwback',   size: { width: 550, height: 232 } },
  { id: 'record-player',     label: 'Record Player',    shortLabel: 'VIN',  tagline: 'Spinning vinyl + tonearm',    size: { width: 540, height: 540 } },
  { id: 'jukebox',           label: 'Jukebox',          shortLabel: 'JUKE', tagline: 'Wurlitzer arch + chrome',     size: { width: 420, height: 560 } },
  { id: 'cassette',          label: 'Cassette Deck',    shortLabel: 'TAPE', tagline: 'Twin spools, magnetic tape',  size: { width: 760, height: 320 } },
  { id: 'hotdog',            label: 'Hotdog Deck',      shortLabel: 'DOG',  tagline: 'Rounded bun transport deck',  size: { width: 740, height: 240 } },
  { id: 'retro-tv',          label: 'Retro TV',         shortLabel: 'TV',   tagline: 'CRT screen + rabbit ears',    size: { width: 520, height: 430 } },
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
