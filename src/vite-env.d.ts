/// <reference types="vite/client" />

import type { NewAmpAPI } from '../shared/types';

declare global {
  interface Window {
    newamp: NewAmpAPI;
    winctl: {
      minimize: () => Promise<void>;
      toggleMax: () => Promise<void>;
      setCompact: (on: boolean, size?: { width?: number; height?: number }) => Promise<void>;
      setCompactSize: (size: { width: number; height: number }) => Promise<void>;
      setAlwaysOnTop: (on: boolean) => Promise<void>;
      close: () => Promise<void>;
      onState: (cb: (s: { maximized: boolean }) => void) => () => void;
    };
    toAudioUrl: (filePath: string) => string;
  }
}

export {};
