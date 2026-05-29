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

export interface BcInitMessage {
  type: 'init';
  sampleRate: number;
  dpr: number;
}
export interface BcAudioMessage {
  type: 'audio';
  samples: Uint8Array;
}
export interface BcDisposeMessage {
  type: 'dispose';
}
export type BcParentMessage = BcInitMessage | BcAudioMessage | BcDisposeMessage;

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
