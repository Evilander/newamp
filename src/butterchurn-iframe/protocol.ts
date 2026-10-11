import type { LiveCompositionFrame } from '../visualizer/eviland-live-pipeline';
// postMessage contract between the main renderer (Visualizer.tsx) and the
// sandboxed Butterchurn iframe (butterchurn-iframe.html / ./main.ts).
//
// The iframe owns Butterchurn (and thus the only eval surface). Audio never
// crosses as a Web Audio node — those can't leave their realm — so the parent
// posts raw time-domain bytes each frame and the iframe feeds them straight to
// butterchurn's render({ audioLevels }) path, bypassing its internal analyser.

// butterchurn's AudioProcessor uses numSamps=512, fftSize=512*2. updateAudio()
// expects time-domain byte arrays of exactly this length.
export const BUTTERCHURN_FFT_SIZE = 1024;

export type BcQuality = 'high' | 'medium' | 'low';

export interface BcInitMessage {
  type: 'init';
  /** Rate of the samples in BcAudioMessage (see feed.ts), not necessarily the device's. */
  sampleRate: number;
  dpr: number;
  /** Most pixels the canvas may have, whatever the dpr; unlimited when absent. */
  maxPixels?: number;
  eviland?: boolean;
  quality?: BcQuality;
}
export interface BcAudioMessage {
  type: 'audio';
  samples: Uint8Array;
  eviland?: LiveCompositionFrame;
  /**
   * Whether the track is playing. A quiet passage reads as flat bytes just
   * like a pause, so when this is sent the frame trusts it for slowing down
   * and for rotating presets; without it, flat bytes are the pause signal.
   */
  playing?: boolean;
}
/** Changes that arrive after init: the window moved displays, the rate or the tier changed. */
export interface BcConfigMessage {
  type: 'config';
  dpr?: number;
  maxPixels?: number;
  quality?: BcQuality;
  sampleRate?: number;
}
export interface BcDisposeMessage {
  type: 'dispose';
}
export type BcParentMessage = BcInitMessage | BcAudioMessage | BcConfigMessage | BcDisposeMessage;

export interface BcReadyMessage {
  type: 'ready';
}
export interface BcMountedMessage {
  type: 'mounted';
}
export interface BcFailedMessage {
  type: 'failed';
  error: string;
}
export type BcFrameMessage = BcReadyMessage | BcMountedMessage | BcFailedMessage;
