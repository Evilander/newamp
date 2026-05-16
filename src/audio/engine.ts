// Newamp audio engine. Two HTMLAudioElement decks feed one EQ/master/analyser
// chain so track changes can overlap for real crossfade instead of muting and
// swapping a single element.

import { normalizeAudioOutputDeviceId } from '@shared/audio-output';
import { normalizeLimiterEnabled, preampDbToLinear } from '@shared/audio-limiter';

export interface EngineState {
  duration: number;
  currentTime: number;
  playing: boolean;
  buffering: boolean;
  ended: boolean;
  src: string | null;
  trackId: number | null;
  error: string | null;
}

export type EngineListener = (e: EngineState) => void;

const EQ_FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];

interface Deck {
  id: number;
  el: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

interface PreparedNextDeck {
  deckId: number;
  src: string;
  trackId: number | null;
  startAt: number;
}

type SinkAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

type SinkAudioElement = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  readonly masterGain: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly eqBands: BiquadFilterNode[];
  private readonly decks: [Deck, Deck];
  private readonly inputGain: GainNode;
  private readonly replayGain: GainNode;
  private activeDeckIndex = 0;
  private crossfadeMs = 0;
  private playbackRate = 1;
  private outputDeviceId: string | null = null;
  private preparedNext: PreparedNextDeck | null = null;

  private state: EngineState = {
    duration: 0,
    currentTime: 0,
    playing: false,
    buffering: false,
    ended: false,
    src: null,
    trackId: null,
    error: null,
  };

  private listeners = new Set<EngineListener>();
  private rafId: number | null = null;
  private fadeTimer: number | null = null;
  private outputTestTimer: number | null = null;
  private outputTestCleanup: Array<() => void> = [];

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    this.inputGain = this.ctx.createGain();
    this.inputGain.gain.value = 1;

    // Build a 10-band EQ.
    this.eqBands = EQ_FREQS.map((freq) => {
      const f = this.ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1.0;
      f.gain.value = 0;
      return f;
    });

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.75;
    this.replayGain = this.ctx.createGain();
    this.replayGain.gain.value = 1;
    this.limiter = this.ctx.createDynamicsCompressor();
    this.configureLimiter(true);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;

    this.decks = [this.createDeck(0), this.createDeck(1)];
    for (const deck of this.decks) {
      deck.source.connect(deck.gain);
      deck.gain.connect(this.inputGain);
    }
    this.decks[0].gain.gain.value = 1;
    this.decks[1].gain.gain.value = 0;

    // Chain: decks -> inputGain/preamp -> EQ chain -> replayGain -> limiter -> masterGain -> analyser -> destination
    let node: AudioNode = this.inputGain;
    for (const band of this.eqBands) {
      node.connect(band);
      node = band;
    }
    node.connect(this.replayGain);
    this.replayGain.connect(this.limiter);
    this.limiter.connect(this.masterGain);
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.tick();
  }

  private createDeck(id: number): Deck {
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    this.configurePlaybackRate(el);
    const source = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    gain.gain.value = 0;

    this.attachElementListeners(el, id);
    return { id, el, source, gain };
  }

  private get activeDeck(): Deck {
    return this.decks[this.activeDeckIndex]!;
  }

  private attachElementListeners(el: HTMLAudioElement, deckId: number): void {
    const patchIfActive = (p: Partial<EngineState>) => {
      if (deckId === this.activeDeckIndex) this.patch(p);
    };
    el.addEventListener('play', () => patchIfActive({ playing: true, ended: false }));
    el.addEventListener('pause', () => patchIfActive({ playing: false }));
    el.addEventListener('ended', () => patchIfActive({ playing: false, ended: true }));
    el.addEventListener('waiting', () => patchIfActive({ buffering: true }));
    el.addEventListener('canplay', () => patchIfActive({ buffering: false }));
    el.addEventListener('playing', () => patchIfActive({ buffering: false }));
    el.addEventListener('loadedmetadata', () =>
      patchIfActive({ duration: Number.isFinite(el.duration) ? el.duration : 0 }),
    );
    el.addEventListener('error', () => {
      if (deckId !== this.activeDeckIndex) return;
      const code = el.error?.code ?? 0;
      this.patch({
        playing: false,
        buffering: false,
        error: `Audio error (code ${code})`,
      });
    });
  }

  private patch(p: Partial<EngineState>): void {
    this.state = { ...this.state, ...p };
    this.notify();
  }

  private notify(): void {
    for (const l of this.listeners) l(this.state);
  }

  private tick = (): void => {
    const el = this.activeDeck.el;
    if (el.src) {
      this.state = {
        ...this.state,
        currentTime: el.currentTime,
        duration: Number.isFinite(el.duration) ? el.duration : this.state.duration,
      };
      this.notify();
    }
    this.rafId = requestAnimationFrame(this.tick);
  };

  subscribe(fn: EngineListener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  getState(): EngineState {
    return this.state;
  }

  async play(src: string, trackId: number | null, startAt = 0): Promise<void> {
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore */
      }
    }

    const current = this.activeDeck;
    if (current.el.src === src || current.el.currentSrc === src) {
      this.patch({ trackId, ended: false, error: null });
      this.applyStartPosition(current, startAt);
      try {
        await current.el.play();
      } catch (err) {
        this.patch({ error: (err as Error).message ?? 'Playback failed' });
        throw err;
      }
      return;
    }

    const preparedDeck = this.findPreparedDeck(src);
    if (preparedDeck) {
      await this.playPreparedDeck(preparedDeck, src, trackId);
      return;
    }

    if (this.crossfadeMs > 0 && current.el.src && !current.el.paused) {
      await this.crossfadeTo(src, trackId, startAt);
      return;
    }

    this.clearFadeTimer();
    this.silenceDeck(this.decks[1 - this.activeDeckIndex]!, true);
    current.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    current.gain.gain.setValueAtTime(1, this.ctx.currentTime);
    this.patch({ src, trackId, currentTime: 0, duration: 0, ended: false, error: null });
    current.el.src = src;
    this.applyStartPosition(current, startAt);
    try {
      await current.el.play();
    } catch (err) {
      this.patch({ error: (err as Error).message ?? 'Playback failed' });
      throw err;
    }
  }

  prepareNext(src: string, trackId: number | null, startAt = 0): void {
    if (!src || this.activeDeck.el.src === src || this.activeDeck.el.currentSrc === src) return;
    const normalizedStartAt = normalizeStartAt(startAt);
    const deck = this.decks[1 - this.activeDeckIndex]!;
    if (
      this.preparedNext?.deckId === deck.id &&
      this.preparedNext.src === src &&
      this.preparedNext.trackId === trackId &&
      this.preparedNext.startAt === normalizedStartAt
    ) {
      return;
    }

    this.silenceDeck(deck, true);
    deck.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    deck.gain.gain.setValueAtTime(0, this.ctx.currentTime);
    deck.el.src = src;
    this.applyStartPosition(deck, normalizedStartAt);
    deck.el.load();
    this.preparedNext = { deckId: deck.id, src, trackId, startAt: normalizedStartAt };
  }

  private findPreparedDeck(src: string): Deck | null {
    if (!this.preparedNext || this.preparedNext.src !== src) return null;
    const deck = this.decks.find((candidate) => candidate.id === this.preparedNext?.deckId) ?? null;
    if (!deck || deck.id === this.activeDeckIndex) return null;
    if (deck.el.src !== src && deck.el.currentSrc !== src) return null;
    return deck;
  }

  private async playPreparedDeck(deck: Deck, src: string, trackId: number | null): Promise<void> {
    const from = this.activeDeck;
    this.clearFadeTimer();
    this.silenceDeck(from, true);
    deck.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    deck.gain.gain.setValueAtTime(1, this.ctx.currentTime);
    this.activeDeckIndex = deck.id;
    this.preparedNext = null;
    this.patch({ src, trackId, currentTime: 0, duration: 0, ended: false, error: null, buffering: true });
    try {
      await deck.el.play();
    } catch (err) {
      this.patch({ error: (err as Error).message ?? 'Playback failed' });
      throw err;
    }
  }

  private async crossfadeTo(src: string, trackId: number | null, startAt = 0): Promise<void> {
    this.clearFadeTimer();
    this.preparedNext = null;

    const from = this.activeDeck;
    const toIndex = 1 - this.activeDeckIndex;
    const to = this.decks[toIndex]!;
    const now = this.ctx.currentTime;
    const seconds = Math.max(0.08, this.crossfadeMs / 1000);

    this.silenceDeck(to, true);
    to.el.src = src;
    this.applyStartPosition(to, startAt);
    to.gain.gain.cancelScheduledValues(now);
    to.gain.gain.setValueAtTime(0, now);
    from.gain.gain.cancelScheduledValues(now);
    from.gain.gain.setValueAtTime(Math.max(0.0001, from.gain.gain.value), now);

    this.activeDeckIndex = toIndex;
    this.patch({
      src,
      trackId,
      currentTime: 0,
      duration: 0,
      ended: false,
      error: null,
      buffering: true,
    });

    try {
      await to.el.play();
    } catch (err) {
      this.activeDeckIndex = from.id;
      this.patch({ error: (err as Error).message ?? 'Playback failed' });
      throw err;
    }

    to.gain.gain.linearRampToValueAtTime(1, now + seconds);
    from.gain.gain.linearRampToValueAtTime(0, now + seconds);
    this.fadeTimer = window.setTimeout(() => {
      if (this.activeDeckIndex !== from.id) this.silenceDeck(from, true);
      this.fadeTimer = null;
    }, this.crossfadeMs + 120);
  }

  private silenceDeck(deck: Deck, clearSrc: boolean): void {
    try {
      deck.el.pause();
      deck.el.currentTime = 0;
      if (clearSrc) {
        deck.el.removeAttribute('src');
        deck.el.load();
      }
      deck.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      deck.gain.gain.setValueAtTime(0, this.ctx.currentTime);
    } catch {
      /* ignore */
    }
  }

  private applyStartPosition(deck: Deck, startAt: number): void {
    const target = normalizeStartAt(startAt);
    if (target <= 0) {
      try {
        deck.el.currentTime = 0;
      } catch {
        /* metadata may not be ready */
      }
      return;
    }
    const seek = () => {
      try {
        const max = Number.isFinite(deck.el.duration) && deck.el.duration > 0 ? deck.el.duration : target;
        deck.el.currentTime = Math.max(0, Math.min(max, target));
      } catch {
        /* metadata may not be ready */
      }
    };
    if (Number.isFinite(deck.el.duration) && deck.el.duration > 0) seek();
    else deck.el.addEventListener('loadedmetadata', seek, { once: true });
  }

  private clearFadeTimer(): void {
    if (this.fadeTimer != null) {
      window.clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
  }

  setCrossfadeMs(ms: number): void {
    this.crossfadeMs = Math.max(0, Math.min(12000, Math.round(ms)));
  }

  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate)) return;
    this.playbackRate = Math.max(0.5, Math.min(1.5, Math.round(rate * 20) / 20));
    for (const deck of this.decks) this.configurePlaybackRate(deck.el);
  }

  async setOutputDevice(deviceId: string | null): Promise<void> {
    const normalized = normalizeAudioOutputDeviceId(deviceId);
    const sinkId = normalized ?? '';
    const tasks: Array<() => Promise<void>> = [];
    const ctx = this.ctx as SinkAudioContext;

    if (typeof ctx.setSinkId === 'function') {
      tasks.push(() => ctx.setSinkId!(sinkId));
    }

    for (const deck of this.decks) {
      const el = deck.el as SinkAudioElement;
      if (typeof el.setSinkId === 'function') {
        tasks.push(() => el.setSinkId!(sinkId));
      }
    }

    if (!tasks.length) {
      if (normalized) {
        throw new Error('Audio output device selection is not supported in this runtime.');
      }
      this.outputDeviceId = normalized;
      return;
    }

    const results = await Promise.allSettled(tasks.map((task) => task()));
    if (results.some((result) => result.status === 'fulfilled')) {
      this.outputDeviceId = normalized;
      return;
    }

    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    throw rejected?.reason ?? new Error('Audio output device switch failed.');
  }

  async playOutputTestTone(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    this.clearOutputTestTone();

    const steps = [
      { freq: 440, pan: 0 },
      { freq: 660, pan: -1 },
      { freq: 880, pan: 1 },
      { freq: 440, pan: 0 },
    ];
    const now = this.ctx.currentTime + 0.04;
    const stepSeconds = 0.65;
    const fadeSeconds = 0.035;
    const peak = 0.16;

    steps.forEach((step, index) => {
      const start = now + index * stepSeconds;
      const end = start + stepSeconds;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const panner = this.ctx.createStereoPanner();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(step.freq, start);
      panner.pan.setValueAtTime(step.pan, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + fadeSeconds);
      gain.gain.setValueAtTime(peak, end - fadeSeconds);
      gain.gain.linearRampToValueAtTime(0, end);

      osc.connect(gain);
      gain.connect(panner);
      panner.connect(this.inputGain);
      osc.start(start);
      osc.stop(end + 0.02);

      this.outputTestCleanup.push(() => {
        try {
          osc.stop();
        } catch {
          /* already stopped */
        }
        try {
          osc.disconnect();
          gain.disconnect();
          panner.disconnect();
        } catch {
          /* already disconnected */
        }
      });
    });

    const totalMs = Math.ceil((steps.length * stepSeconds + 0.12) * 1000);
    return new Promise((resolve) => {
      this.outputTestTimer = window.setTimeout(() => {
        this.clearOutputTestTone();
        resolve();
      }, totalMs);
    });
  }

  private clearOutputTestTone(): void {
    if (this.outputTestTimer != null) {
      window.clearTimeout(this.outputTestTimer);
      this.outputTestTimer = null;
    }
    for (const cleanup of this.outputTestCleanup) cleanup();
    this.outputTestCleanup = [];
  }

  private configurePlaybackRate(el: HTMLAudioElement): void {
    el.playbackRate = this.playbackRate;
    const pitchPreserving = el as HTMLAudioElement & {
      preservesPitch?: boolean;
      mozPreservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    pitchPreserving.preservesPitch = true;
    pitchPreserving.mozPreservesPitch = true;
    pitchPreserving.webkitPreservesPitch = true;
  }

  pause(): void {
    for (const deck of this.decks) deck.el.pause();
  }

  togglePlayPause(): void {
    const active = this.activeDeck.el;
    if (!active.src) return;
    if (active.paused) {
      void active.play();
    } else {
      this.pause();
    }
  }

  stop(): void {
    this.clearFadeTimer();
    this.preparedNext = null;
    for (const deck of this.decks) {
      deck.el.pause();
      deck.el.currentTime = 0;
      deck.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      deck.gain.gain.setValueAtTime(deck.id === this.activeDeckIndex ? 1 : 0, this.ctx.currentTime);
    }
    this.patch({ playing: false, currentTime: 0, ended: false, buffering: false, error: null });
  }

  seek(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    const el = this.activeDeck.el;
    el.currentTime = Math.max(0, Math.min(el.duration || 0, seconds));
  }

  setVolume(v: number): void {
    const clamped = Math.max(0, Math.min(1, v));
    this.masterGain.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.01);
  }

  setReplayGainDb(db: number | null): void {
    const clampedDb = db == null || !Number.isFinite(db) ? 0 : Math.max(-18, Math.min(12, db));
    const linear = Math.pow(10, clampedDb / 20);
    this.replayGain.gain.setTargetAtTime(linear, this.ctx.currentTime, 0.02);
  }

  setPreampDb(db: number): void {
    this.inputGain.gain.setTargetAtTime(preampDbToLinear(db), this.ctx.currentTime, 0.02);
  }

  setLimiterEnabled(enabled: boolean): void {
    this.configureLimiter(normalizeLimiterEnabled(enabled));
  }

  private configureLimiter(enabled: boolean): void {
    const now = this.ctx.currentTime;
    this.limiter.threshold.setTargetAtTime(enabled ? -1 : 0, now, 0.01);
    this.limiter.knee.setTargetAtTime(0, now, 0.01);
    this.limiter.ratio.setTargetAtTime(enabled ? 20 : 1, now, 0.01);
    this.limiter.attack.setTargetAtTime(enabled ? 0.003 : 0, now, 0.01);
    this.limiter.release.setTargetAtTime(enabled ? 0.12 : 0.01, now, 0.01);
  }

  setEqBand(index: number, dB: number): void {
    const band = this.eqBands[index];
    if (!band) return;
    band.gain.setTargetAtTime(Math.max(-12, Math.min(12, dB)), this.ctx.currentTime, 0.015);
  }

  setEqBands(values: number[]): void {
    values.forEach((v, i) => this.setEqBand(i, v));
  }

  setEqEnabled(on: boolean): void {
    // bypass by zeroing all bands when off; cheaper than rewiring graph
    if (!on) for (const b of this.eqBands) b.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
  }

  getFreqData(buf: Uint8Array<ArrayBuffer>): void {
    this.analyser.getByteFrequencyData(buf);
  }

  getTimeData(buf: Uint8Array<ArrayBuffer>): void {
    this.analyser.getByteTimeDomainData(buf);
  }

  dispose(): void {
    this.clearFadeTimer();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    for (const deck of this.decks) {
      try {
        deck.el.pause();
        deck.el.src = '';
      } catch {
        /* ignore */
      }
    }
    this.ctx.close().catch(() => undefined);
  }
}

export const EQ_BAND_FREQS = EQ_FREQS;

function normalizeStartAt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(0, value) : 0;
}
