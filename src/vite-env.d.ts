/// <reference types="vite/client" />

import type { NewAmpAPI } from '../shared/types';

interface DetachedDisplay {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  internal: boolean;
  primary: boolean;
}

interface DetachedVizBridge {
  listDisplays: () => Promise<DetachedDisplay[]>;
  open: (opts?: { displayId?: number; fullscreen?: boolean }) => Promise<void>;
  close: () => Promise<void>;
  moveToDisplay: (displayId: number) => Promise<void>;
  setFullscreen: (on: boolean) => Promise<void>;
  toggleFullscreen: () => Promise<boolean>;
  isFullscreen: () => Promise<boolean>;
  transportCommand: (
    cmd: 'togglePlay' | 'next' | 'prev' | 'seek' | 'setVolume',
    arg?: number,
  ) => Promise<void>;
  isOpen: () => Promise<boolean>;
  rendererReady?: () => void;
  onOpened: (cb: () => void) => () => void;
  onClosed: (cb: () => void) => () => void;
  onCrashed: (cb: (reason: string) => void) => () => void;
  onOpenFailed: (cb: (reason: string) => void) => () => void;
  onDisplaysChanged: (cb: () => void) => () => void;
  onTransportCommand: (
    cb: (cmd: 'togglePlay' | 'next' | 'prev' | 'seek' | 'setVolume', arg?: number) => void,
  ) => () => void;
}

declare global {
  interface Window {
    newamp: NewAmpAPI;
    winctl: {
      minimize: () => Promise<void>;
      toggleMax: () => Promise<void>;
      setFullscreen: (on: boolean) => Promise<void>;
      isFullscreen: () => Promise<boolean>;
      setCompact: (on: boolean, size?: { width?: number; height?: number }) => Promise<void>;
      setCompactSize: (size: { width: number; height: number }) => Promise<void>;
      setAlwaysOnTop: (on: boolean) => Promise<void>;
      close: () => Promise<void>;
      notifyPlayback: (state: {
        isPlaying: boolean;
        title: string | null;
        artist: string | null;
        album: string | null;
        trackId: number | null;
        position: number;
        duration: number;
        volume: number;
      }) => void;
      onState: (cb: (s: { maximized: boolean }) => void) => () => void;
    };
    detachedViz: DetachedVizBridge;
    toAudioUrl: (filePath: string) => string;
  }
}

export {};
