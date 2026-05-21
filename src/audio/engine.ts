// NewAmp audio engine. Two HTMLAudioElement decks feed one EQ/master/analyser
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
const DEFAULT_FFT_SIZE = 2048;
const DEFAULT_FREQUENCY_BIN_COUNT = DEFAULT_FFT_SIZE / 2;
// How long the VBR-seek diagnostic waits before sampling currentTime.
// Long enough for a normal seek to settle on slow files, short enough
// that a typical user-perceived seek failure (restart) is caught before
// the next user action. Tuning higher than ~300ms starts catching
// legitimate fast track-changes; lower than ~150ms misses real seeks.
const SEEK_VERIFY_MS = 220;

interface Deck {
  id: number;
  el: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

interface AudioGraph {
  ctx: AudioContext;
  analyser: AnalyserNode;
  onsetAnalyser: AnalyserNode;
  masterGain: GainNode;
  limiter: DynamicsCompressorNode;
  eqBands: BiquadFilterNode[];
  decks: [Deck, Deck];
  inputGain: GainNode;
  replayGain: GainNode;
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
  private graph: AudioGraph | null = null;
  private activeDeckIndex = 0;
  private crossfadeMs = 0;
  private playbackRate = 1;
  private volume = 0.75;
  private replayGainLinear = 1;
  private preampLinear = 1;
  private limiterEnabled = true;
  private eqEnabled = true;
  private eqValues = EQ_FREQS.map(() => 0);
  private outputDeviceId: string | null = null;
  private preferredSampleRate: number | null = null;
  private preparedNext: PreparedNextDeck | null = null;
  // Monotonically increments each call to `seek`. The 220ms verify timer
  // captures this value and bails if a newer seek (or track-change) has
  // happened in the meantime — otherwise rapid seekbar drags fire dozens
  // of false-positive "seek failed" warnings.
  private seekSeq = 0;

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

  get ctx(): AudioContext {
    return this.ensureGraph().ctx;
  }

  get context(): AudioContext {
    return this.ensureGraph().ctx;
  }

  get masterGain(): GainNode {
    return this.ensureGraph().masterGain;
  }

  get visualizerNode(): AudioNode {
    return this.ensureGraph().analyser;
  }

  get frequencyBinCount(): number {
    return this.graph?.analyser.frequencyBinCount ?? DEFAULT_FREQUENCY_BIN_COUNT;
  }

  get fftSize(): number {
    return this.graph?.analyser.fftSize ?? DEFAULT_FFT_SIZE;
  }

  private get decks(): [Deck, Deck] {
    return this.ensureGraph().decks;
  }

  setPreferredSampleRate(rate: number | null): void {
    const normalized = rate && Number.isFinite(rate) && rate >= 8000 && rate <= 384000 ? Math.trunc(rate) : null;
    if (normalized === this.preferredSampleRate) return;
    this.preferredSampleRate = normalized;
    // We don't rip down a live graph - that would interrupt playback. The
    // preference takes effect the next time the engine boots its
    // AudioContext, which is the first playback after launch. The Settings
    // UI explains this and offers a one-click "Reload to apply" action.
  }

  getActualSampleRate(): number | null {
    return this.graph?.ctx.sampleRate ?? null;
  }

  isSampleRateMatched(trackSampleRate: number | null | undefined): boolean {
    if (!this.graph || !trackSampleRate || !Number.isFinite(trackSampleRate)) return false;
    return Math.abs(this.graph.ctx.sampleRate - trackSampleRate) < 1;
  }

  private ensureGraph(): AudioGraph {
    if (this.graph) return this.graph;

    const contextOptions: AudioContextOptions = { latencyHint: 'playback' };
    if (this.preferredSampleRate) {
      contextOptions.sampleRate = this.preferredSampleRate;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext(contextOptions);
    } catch {
      // Chromium rejects unsupported sample rates with NotSupportedError. Fall
      // back to the device default so playback never gates on a setting.
      ctx = new AudioContext({ latencyHint: 'playback' });
    }
    const inputGain = ctx.createGain();
    inputGain.gain.value = this.preampLinear;

    const eqBands = EQ_FREQS.map((freq, index) => {
      const filter = ctx.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = freq;
      filter.Q.value = 1.0;
      filter.gain.value = this.eqEnabled ? (this.eqValues[index] ?? 0) : 0;
      return filter;
    });

    const masterGain = ctx.createGain();
    masterGain.gain.value = this.volume;
    const replayGain = ctx.createGain();
    replayGain.gain.value = this.replayGainLinear;
    const limiter = ctx.createDynamicsCompressor();

    const analyser = ctx.createAnalyser();
    analyser.fftSize = DEFAULT_FFT_SIZE;
    analyser.minDecibels = -86;
    analyser.maxDecibels = -10;
    analyser.smoothingTimeConstant = 0.24;
    // Dedicated unsmoothed analyser for onset detection. The visualizer
    // analyser smooths over ~1.3 frames which makes "rising-edge" beat
    // detection lag behind real transients. This tap reads raw frame energy
    // so kick-drum onset gates fire in the right frame.
    const onsetAnalyser = ctx.createAnalyser();
    onsetAnalyser.fftSize = DEFAULT_FFT_SIZE;
    onsetAnalyser.minDecibels = -86;
    onsetAnalyser.maxDecibels = -10;
    onsetAnalyser.smoothingTimeConstant = 0;

    const decks = [this.createDeck(0, ctx), this.createDeck(1, ctx)] as [Deck, Deck];
    for (const deck of decks) {
      deck.source.connect(deck.gain);
      deck.gain.connect(inputGain);
    }
    decks[0].gain.gain.value = 1;
    decks[1].gain.gain.value = 0;

    let node: AudioNode = inputGain;
    for (const band of eqBands) {
      node.connect(band);
      node = band;
    }
    // Signal chain:
    //   source → eq → replayGain ─┬─→ masterGain (volume) → limiter → destination
    //                             ├─→ analyser (visualization tap)
    //                             └─→ onsetAnalyser (unsmoothed onset tap)
    //                                  ↓
    //                              silentSink (gain=0) → destination
    //
    // Volume (masterGain) is upstream of the limiter so any boost past unity
    // still hits the limiter and the device never clips. The analyser is a
    // parallel sink off replayGain so visualizers see pre-volume audio and
    // stay reactive when the user listens quietly.
    //
    // The `silentSink` is load-bearing: AnalyserNode subtrees that don't
    // reach `AudioDestinationNode` may be culled by Chrome/Electron's graph
    // optimizer, leaving the FFT buffer frozen at zero — which is exactly
    // what made butterchurn fail to react in 1.5.3. Routing both analysers
    // to destination via a 0-gain GainNode keeps the subtree alive without
    // adding any audible signal. This is the standard Web Audio pattern.
    const silentSink = ctx.createGain();
    silentSink.gain.value = 0;
    silentSink.connect(ctx.destination);

    node.connect(replayGain);
    replayGain.connect(masterGain);
    replayGain.connect(analyser);
    replayGain.connect(onsetAnalyser);
    analyser.connect(silentSink);
    onsetAnalyser.connect(silentSink);
    masterGain.connect(limiter);
    limiter.connect(ctx.destination);

    const graph = {
      ctx,
      analyser,
      onsetAnalyser,
      masterGain,
      limiter,
      eqBands,
      decks,
      inputGain,
      replayGain,
    };
    this.graph = graph;
    this.applyLimiter(graph, this.limiterEnabled);
    this.startTick();

    if (this.outputDeviceId) {
      void this.applyOutputDevice(this.outputDeviceId).catch(() => undefined);
    }

    return graph;
  }

  private createDeck(id: number, ctx: AudioContext): Deck {
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    this.configurePlaybackRate(el);
    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
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

  private startTick(): void {
    if (this.rafId == null) this.rafId = requestAnimationFrame(this.tick);
  }

  private tick = (): void => {
    this.rafId = null;
    if (!this.graph) return;
    const el = this.graph.decks[this.activeDeckIndex]!.el;
    if (el.src) {
      const nextTime = el.currentTime;
      const nextDuration = Number.isFinite(el.duration) ? el.duration : this.state.duration;
      // Throttle notification frequency. Audio time advances at 60 fps via
      // RAF, but the React tree only needs a refresh every ~100 ms — that's
      // plenty for the time display, scrub bar, and waveform overhead. Going
      // from 60 fps to 10 fps notifications cuts NowPlayingView re-renders
      // by 6x, which is the dominant contributor to gradual slowdown over
      // long playback sessions.
      const prevTimeBucket = Math.floor(this.state.currentTime * 10);
      const nextTimeBucket = Math.floor(nextTime * 10);
      const seekOrJump = Math.abs(nextTime - this.state.currentTime) > 0.5;
      const durationChanged = nextDuration !== this.state.duration;
      this.state = {
        ...this.state,
        currentTime: nextTime,
        duration: nextDuration,
      };
      if (nextTimeBucket !== prevTimeBucket || seekOrJump || durationChanged) {
        this.notify();
      }
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
    const graph = this.ensureGraph();
    if (graph.ctx.state === 'suspended') {
      try {
        await graph.ctx.resume();
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
    this.silenceDeck(graph.decks[1 - this.activeDeckIndex]!, true);
    current.gain.gain.cancelScheduledValues(graph.ctx.currentTime);
    current.gain.gain.setValueAtTime(1, graph.ctx.currentTime);
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
    if (!src || !this.graph) return;
    if (this.activeDeck.el.src === src || this.activeDeck.el.currentSrc === src) return;
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
    deck.gain.gain.cancelScheduledValues(this.graph.ctx.currentTime);
    deck.gain.gain.setValueAtTime(0, this.graph.ctx.currentTime);
    deck.el.src = src;
    this.applyStartPosition(deck, normalizedStartAt);
    deck.el.load();
    this.preparedNext = { deckId: deck.id, src, trackId, startAt: normalizedStartAt };
  }

  private findPreparedDeck(src: string): Deck | null {
    if (!this.graph || !this.preparedNext || this.preparedNext.src !== src) return null;
    const deck = this.graph.decks.find((candidate) => candidate.id === this.preparedNext?.deckId) ?? null;
    if (!deck || deck.id === this.activeDeckIndex) return null;
    if (deck.el.src !== src && deck.el.currentSrc !== src) return null;
    return deck;
  }

  private async playPreparedDeck(deck: Deck, src: string, trackId: number | null): Promise<void> {
    const graph = this.ensureGraph();
    const from = this.activeDeck;
    this.clearFadeTimer();
    this.silenceDeck(from, true);
    deck.gain.gain.cancelScheduledValues(graph.ctx.currentTime);
    deck.gain.gain.setValueAtTime(1, graph.ctx.currentTime);
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
    const graph = this.ensureGraph();
    this.clearFadeTimer();
    this.preparedNext = null;

    const from = this.activeDeck;
    const toIndex = 1 - this.activeDeckIndex;
    const to = graph.decks[toIndex]!;
    const now = graph.ctx.currentTime;
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
    const graph = this.graph;
    if (!graph) return;
    try {
      deck.el.pause();
      deck.el.currentTime = 0;
      if (clearSrc) {
        deck.el.removeAttribute('src');
        deck.el.load();
      }
      deck.gain.gain.cancelScheduledValues(graph.ctx.currentTime);
      deck.gain.gain.setValueAtTime(0, graph.ctx.currentTime);
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
    if (!this.graph) return;
    for (const deck of this.graph.decks) this.configurePlaybackRate(deck.el);
  }

  async setOutputDevice(deviceId: string | null): Promise<void> {
    const normalized = normalizeAudioOutputDeviceId(deviceId);
    this.outputDeviceId = normalized;
    if (!this.graph) return;
    await this.applyOutputDevice(normalized);
  }

  private async applyOutputDevice(deviceId: string | null): Promise<void> {
    const graph = this.ensureGraph();
    const sinkId = deviceId ?? '';
    const tasks: Array<() => Promise<void>> = [];
    const ctx = graph.ctx as SinkAudioContext;

    if (typeof ctx.setSinkId === 'function') {
      tasks.push(() => ctx.setSinkId!(sinkId));
    }

    for (const deck of graph.decks) {
      const el = deck.el as SinkAudioElement;
      if (typeof el.setSinkId === 'function') {
        tasks.push(() => el.setSinkId!(sinkId));
      }
    }

    if (!tasks.length) {
      if (deviceId) throw new Error('Audio output device selection is not supported in this runtime.');
      return;
    }

    const results = await Promise.allSettled(tasks.map((task) => task()));
    if (results.some((result) => result.status === 'fulfilled')) return;

    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    throw rejected?.reason ?? new Error('Audio output device switch failed.');
  }

  async playOutputTestTone(): Promise<void> {
    const graph = this.ensureGraph();
    if (graph.ctx.state === 'suspended') {
      await graph.ctx.resume();
    }

    this.clearOutputTestTone();

    const steps = [
      { freq: 440, pan: 0 },
      { freq: 660, pan: -1 },
      { freq: 880, pan: 1 },
      { freq: 440, pan: 0 },
    ];
    const now = graph.ctx.currentTime + 0.04;
    const stepSeconds = 0.65;
    const fadeSeconds = 0.035;
    const peak = 0.16;

    steps.forEach((step, index) => {
      const start = now + index * stepSeconds;
      const end = start + stepSeconds;
      const osc = graph.ctx.createOscillator();
      const gain = graph.ctx.createGain();
      const panner = graph.ctx.createStereoPanner();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(step.freq, start);
      panner.pan.setValueAtTime(step.pan, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + fadeSeconds);
      gain.gain.setValueAtTime(peak, end - fadeSeconds);
      gain.gain.linearRampToValueAtTime(0, end);

      osc.connect(gain);
      gain.connect(panner);
      panner.connect(graph.inputGain);
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
    if (!this.graph) {
      this.patch({ playing: false });
      return;
    }
    for (const deck of this.graph.decks) deck.el.pause();
  }

  togglePlayPause(): void {
    if (!this.graph) return;
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
    if (!this.graph) {
      this.patch({ playing: false, currentTime: 0, ended: false, buffering: false, error: null });
      return;
    }
    for (const deck of this.graph.decks) {
      deck.el.pause();
      deck.el.currentTime = 0;
      deck.gain.gain.cancelScheduledValues(this.graph.ctx.currentTime);
      deck.gain.gain.setValueAtTime(deck.id === this.activeDeckIndex ? 1 : 0, this.graph.ctx.currentTime);
    }
    this.patch({ playing: false, currentTime: 0, ended: false, buffering: false, error: null });
  }

  seek(seconds: number): void {
    if (!Number.isFinite(seconds) || !this.graph) return;
    const el = this.activeDeck.el;
    const target = Math.max(0, Math.min(el.duration || 0, seconds));
    const previous = el.currentTime;
    el.currentTime = target;
    // VBR seek diagnostic: VBR MP3s without a Xing/Info header
    // (reproduces on LAME --vbr-old encodes) can't be seeked accurately
    // by HTMLAudioElement — Chromium guesses byte position and may
    // restart from 0 instead of landing at the target. The check below
    // detects that case and logs it. Skipped if either anchor (target
    // or previous position) is at the very start of the file, because a
    // genuine seek-to-zero or play-from-zero would false-positive.
    if (target > 1 && previous > 1) {
      // Snapshot deck identity + src + a monotonic seek-id at schedule
      // time. The 220ms verify window is long enough for a normal seek
      // to settle, but also long enough for the user to drag the seekbar
      // multiple times or skip to the next track. We must not log a
      // "seek failed" against a deck that has since been swapped or a
      // track that has since changed under us — that produced 30+
      // false-positive warnings per seekbar drag in 1.5.4-1.5.6.
      const scheduledSeq = ++this.seekSeq;
      const scheduledDeckIndex = this.activeDeckIndex;
      const scheduledEl = el;
      const scheduledSrc = el.currentSrc;
      window.setTimeout(() => {
        if (!this.graph) return;
        if (this.seekSeq !== scheduledSeq) return; // newer seek superseded
        if (this.activeDeckIndex !== scheduledDeckIndex) return; // crossfade swap
        if (this.activeDeck.el !== scheduledEl) return; // deck re-bound
        if (this.activeDeck.el.currentSrc !== scheduledSrc) return; // track changed
        const landed = this.activeDeck.el.currentTime;
        const restarted = landed < 0.5;
        const farOff = !restarted && Math.abs(landed - target) > 1.5;
        if (restarted || farOff) {
          console.warn(
            '[newamp] seek failed:',
            { target, landed, restarted, farOff, src: scheduledSrc },
            'Most likely a VBR MP3 without a Xing/Info header; HTMLAudioElement cannot seek these accurately. Consider re-encoding the file.',
          );
        }
      }, SEEK_VERIFY_MS);
    }
  }

  setVolume(v: number): void {
    // Volume range extends to 2.0 (VLC-style boost). masterGain is upstream of
    // the limiter (see graph wiring), so values past 1.0 are caught by the
    // limiter and never reach the device above 0 dBFS. No more silent
    // post-limiter clipping when users push past unity.
    this.volume = Math.max(0, Math.min(2, v));
    if (!this.graph) return;
    this.graph.masterGain.gain.setTargetAtTime(this.volume, this.graph.ctx.currentTime, 0.01);
  }

  setReplayGainDb(db: number | null): void {
    const clampedDb = db == null || !Number.isFinite(db) ? 0 : Math.max(-18, Math.min(12, db));
    this.replayGainLinear = Math.pow(10, clampedDb / 20);
    if (!this.graph) return;
    this.graph.replayGain.gain.setTargetAtTime(this.replayGainLinear, this.graph.ctx.currentTime, 0.02);
  }

  setPreampDb(db: number): void {
    this.preampLinear = preampDbToLinear(db);
    if (!this.graph) return;
    this.graph.inputGain.gain.setTargetAtTime(this.preampLinear, this.graph.ctx.currentTime, 0.02);
  }

  setLimiterEnabled(enabled: boolean): void {
    this.limiterEnabled = normalizeLimiterEnabled(enabled);
    if (this.graph) this.applyLimiter(this.graph, this.limiterEnabled);
  }

  private applyLimiter(graph: AudioGraph, enabled: boolean): void {
    const now = graph.ctx.currentTime;
    graph.limiter.threshold.setTargetAtTime(enabled ? -1 : 0, now, 0.01);
    graph.limiter.knee.setTargetAtTime(0, now, 0.01);
    graph.limiter.ratio.setTargetAtTime(enabled ? 20 : 1, now, 0.01);
    graph.limiter.attack.setTargetAtTime(enabled ? 0.003 : 0, now, 0.01);
    graph.limiter.release.setTargetAtTime(enabled ? 0.12 : 0.01, now, 0.01);
  }

  setEqBand(index: number, dB: number): void {
    if (index < 0 || index >= this.eqValues.length) return;
    const value = Math.max(-12, Math.min(12, dB));
    this.eqValues[index] = value;
    if (!this.graph || !this.eqEnabled) return;
    const band = this.graph.eqBands[index];
    if (!band) return;
    band.gain.setTargetAtTime(value, this.graph.ctx.currentTime, 0.015);
  }

  setEqBands(values: number[]): void {
    values.forEach((value, index) => this.setEqBand(index, value));
  }

  setEqEnabled(on: boolean): void {
    this.eqEnabled = on;
    if (!this.graph) return;
    this.graph.eqBands.forEach((band, index) => {
      const value = this.eqEnabled ? (this.eqValues[index] ?? 0) : 0;
      band.gain.setTargetAtTime(value, this.graph!.ctx.currentTime, 0.02);
    });
  }

  getFreqData(buf: Uint8Array<ArrayBuffer>): void {
    if (!this.graph) {
      buf.fill(0);
      return;
    }
    this.graph.analyser.getByteFrequencyData(buf);
  }

  getTimeData(buf: Uint8Array<ArrayBuffer>): void {
    if (!this.graph) {
      buf.fill(128);
      return;
    }
    this.graph.analyser.getByteTimeDomainData(buf);
  }

  /**
   * Read frequency data from the unsmoothed onset-detection analyser. Use this
   * for transient/kick detection where the visualizer's smoothed analyser
   * (smoothingTimeConstant=0.24) would lag real beats by ~1.3 frames.
   */
  getOnsetFreqData(buf: Uint8Array<ArrayBuffer>): void {
    if (!this.graph) {
      buf.fill(0);
      return;
    }
    this.graph.onsetAnalyser.getByteFrequencyData(buf);
  }

  /** Current audio sample rate in Hz, or null when the engine has not booted. */
  getSampleRate(): number {
    return this.graph?.ctx.sampleRate ?? 48000;
  }

  dispose(): void {
    this.clearFadeTimer();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (!this.graph) return;
    for (const deck of this.graph.decks) {
      try {
        deck.el.pause();
        deck.el.src = '';
      } catch {
        /* ignore */
      }
    }
    this.graph.ctx.close().catch(() => undefined);
    this.graph = null;
  }
}

export const EQ_BAND_FREQS = EQ_FREQS;

function normalizeStartAt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(0, value) : 0;
}
