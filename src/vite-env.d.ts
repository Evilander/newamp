/// <reference types="vite/client" />

import type { NewampAPI } from '../shared/types';

declare global {
  interface Window {
    newamp: NewampAPI;
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
