// NewAmp audio engine. Two HTMLAudioElement decks feed one EQ/master/analyser
// chain so track changes can overlap for real crossfade instead of muting and
// swapping a single element.

import { normalizeAudioOutputDeviceId } from '@shared/audio-output';
import { planDeviceChange } from './device-change';
import { normalizeLimiterEnabled, preampDbToLinear } from '@shared/audio-limiter';
import type { ExclusiveNegotiated } from '@shared/types';

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

/**
 * An alternate playback backend (Bit-Perfect Exclusive: native WASAPI in the
 * main process). When attached AND a track is accepted by it, the engine
 * delegates transport (play/pause/seek/stop/prepareNext) and the Web Audio
 * decks stay silent; the backend pushes position/ended/error state back
 * through `engine.patchExternal()`, so the store and every downstream
 * consumer (shell notify, scrobbling, sleep timer, queue advance) work
 * unchanged. `play` returning false means "this track can't go external —
 * use the normal deck path" (podcasts, missing ids, device failure).
 */
export interface ExternalTransport {
  play(trackId: number, startAt: number): Promise<boolean>;
  pause(): void;
  resume(): void;
  stop(): void;
  seek(seconds: number): void;
  prepareNext(trackId: number | null, startAt: number): void;
}

/**
 * Analyser-compatible data source fed from outside the Web Audio graph
 * (the exclusive path's 30Hz PCM tap). Serves the same byte formats the
 * AnalyserNodes produce so every visualizer keeps working unchanged.
 */
export interface ExternalAnalysisSource {
  isFresh(): boolean;
  getSampleRate(): number;
  getFreqData(buf: Uint8Array): void;
  getTimeData(buf: Uint8Array): void;
  getOnsetFreqData(buf: Uint8Array): void;
  getOnsetTimeData(buf: Uint8Array): void;
  getLeftFreqData(buf: Uint8Array): void;
  getRightFreqData(buf: Uint8Array): void;
}

export interface ExclusiveInfo {
  active: boolean;
  negotiated: ExclusiveNegotiated | null;
  fallbackReason: string | null;
}

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
  /** Pending deferred seek listener (loadedmetadata) so it can be cancelled
   *  when the deck is silenced or a newer deferred seek replaces it. */
  pendingSeek?: { handler: () => void } | null;
}

interface AudioGraph {
  ctx: AudioContext;
  analyser: AnalyserNode;
  onsetAnalyser: AnalyserNode;
  stereoSplitter: ChannelSplitterNode;
  leftAnalyser: AnalyserNode;
  rightAnalyser: AnalyserNode;
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

// Human loudness is ~logarithmic; a linear slider->gain map crams nearly all
// audible change into the bottom of the travel (the "slider does nothing past
// ~15%" complaint). Cubic taper below unity makes equal slider movement ~=
// equal perceived loudness; the 1.0-2.0 boost zone stays linear (limiter
// catches >0dBFS). Unity (1.0) preserved exactly.
function volumePositionToGain(position: number): number {
  const p = Math.max(0, Math.min(2, position));
  if (p <= 1) return p * p * p;
  return p;
}

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
  // applyLimiter owns the masterGain → (limiter) → destination edge.
  // `limiterWired` lets the first (boot) wiring skip the anti-click mute dip;
  // `limiterDipTimer` lets a rapid re-toggle cancel a pending dip.
  private limiterWired = false;
  private limiterDipTimer: number | null = null;
  // Set when ensureGraph asks for a sample rate the device rejects and we fall
  // back to the default — surfaced in the Bit-Perfect UI so the rate request
  // never fails silently.
  private sampleRateFallback: { requested: number; actual: number } | null = null;
  private deviceFallback: { requestedId: string } | null = null;
  private deviceChangeHandler: (() => void) | null = null;
  // Bit-Perfect Exclusive backend. `externalActive` is per-track: it is only
  // true while the CURRENT track was accepted by the external transport, so
  // unsupported sources (podcasts, files without ids) fall back per-play.
  private externalTransport: ExternalTransport | null = null;
  private externalTap: ExternalAnalysisSource | null = null;
  private externalActive = false;
  private exclusiveNegotiated: ExclusiveNegotiated | null = null;
  private exclusiveFallbackReason: string | null = null;
  // Monotonic play-request counter (mirrors seekSeq): tryExternalPlay awaits
  // an IPC round-trip, so a rapid skip can otherwise let a STALE acceptance
  // clobber the newer track's state.
  private playSeq = 0;

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
  private tickTimer: number | null = null;
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
    this.sampleRateFallback = null;
    try {
      ctx = new AudioContext(contextOptions);
    } catch (err) {
      // Chromium rejects unsupported sample rates with NotSupportedError. Fall
      // back to the device default so playback never gates on a setting — but
      // RECORD it (and warn) so the Bit-Perfect UI can tell the user their
      // requested rate was rejected instead of silently showing the wrong one.
      ctx = new AudioContext({ latencyHint: 'playback' });
      if (this.preferredSampleRate && Math.abs(ctx.sampleRate - this.preferredSampleRate) >= 1) {
        this.sampleRateFallback = { requested: this.preferredSampleRate, actual: ctx.sampleRate };
        console.warn(
          `[newamp] requested sample rate ${this.preferredSampleRate} Hz not supported by the output device; running at ${ctx.sampleRate} Hz instead.`,
          err,
        );
      }
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
    // Stereo split for the Eviland flagship visualizer's stereo width/pan
    // features. A ChannelSplitter off replayGain feeds one analyser per
    // channel; like the mono analysers above they route to the silent sink so
    // the subtree is never graph-culled. Unsmoothed for transient-accurate
    // per-channel energy.
    const stereoSplitter = ctx.createChannelSplitter(2);
    const leftAnalyser = ctx.createAnalyser();
    const rightAnalyser = ctx.createAnalyser();
    for (const a of [leftAnalyser, rightAnalyser]) {
      a.fftSize = DEFAULT_FFT_SIZE;
      a.minDecibels = -86;
      a.maxDecibels = -10;
      a.smoothingTimeConstant = 0;
    }

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
    replayGain.connect(stereoSplitter);
    stereoSplitter.connect(leftAnalyser, 0);
    stereoSplitter.connect(rightAnalyser, 1);
    analyser.connect(silentSink);
    onsetAnalyser.connect(silentSink);
    leftAnalyser.connect(silentSink);
    rightAnalyser.connect(silentSink);
    // masterGain → (limiter) → destination routing is owned by applyLimiter()
    // so the limiter can be TRULY bypassed (disconnected from the graph) when
    // the user turns it off, instead of left in-chain at unity ratio.

    const graph = {
      ctx,
      analyser,
      onsetAnalyser,
      stereoSplitter,
      leftAnalyser,
      rightAnalyser,
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
    this.registerDeviceChangeListener();

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
    el.addEventListener('play', () => {
      patchIfActive({ playing: true, ended: false });
      this.startTick();
    });
    el.addEventListener('pause', () => patchIfActive({ playing: false }));
    el.addEventListener('ended', () => patchIfActive({ playing: false, ended: true }));
    el.addEventListener('waiting', () => patchIfActive({ buffering: true }));
    el.addEventListener('canplay', () => patchIfActive({ buffering: false }));
    el.addEventListener('playing', () => {
      patchIfActive({ buffering: false });
      this.startTick();
    });
    el.addEventListener('seeked', () => {
      if (deckId !== this.activeDeckIndex) return;
      // Reflect the seeked position right away — while paused the rAF poll is
      // suspended, so without this the scrubber/clock would not move until the
      // next play. Re-arm the poll if we're actually playing.
      this.patch({ currentTime: Number.isFinite(el.currentTime) ? el.currentTime : this.state.currentTime });
      if (!el.paused && !el.ended) this.startTick();
    });
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
    // setInterval, NOT requestAnimationFrame. rAF rides the compositor's
    // BeginFrame stream, which stops when this window is occluded (e.g. the
    // detached projector covering it on a single monitor) or minimized — even
    // with backgroundThrottling disabled. A frozen tick froze currentTime,
    // which silently stalled everything gated on it: the projector's scrub
    // bar/clock, gapless prepare + crossfade handoff, cue-sheet segment
    // advancement, the sleep timer, scrobbling, and resume-state persistence.
    // Timers keep running (Chromium exempts audibly-playing pages from timer
    // throttling), and notify() was already bucketed to 100 ms, so a 100 ms
    // interval delivers the exact same UI update rate with none of the
    // occlusion failure modes.
    if (this.tickTimer == null) this.tickTimer = window.setInterval(this.tick, 100);
  }

  private stopTick(): void {
    if (this.tickTimer != null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private tick = (): void => {
    if (!this.graph) {
      this.stopTick();
      return;
    }
    const el = this.graph.decks[this.activeDeckIndex]!.el;
    if (el.src) {
      const nextTime = el.currentTime;
      const nextDuration = Number.isFinite(el.duration) ? el.duration : this.state.duration;
      // Notification granularity: the React tree only needs a refresh every
      // ~100 ms — plenty for the time display, scrub bar, and waveform
      // overhead, and it keeps NowPlayingView re-renders from degrading long
      // playback sessions.
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
    // Only keep polling while audio is actually advancing. A poll running with
    // playback paused/ended/idle burns CPU + battery for the whole app
    // lifetime; play/playing/seeked re-arm the loop via startTick().
    if (!el.src || el.paused || el.ended) {
      this.stopTick();
    }
  };

  subscribe(fn: EngineListener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  getState(): EngineState {
    return this.state;
  }

  // ---- Bit-Perfect Exclusive seam -----------------------------------------

  setExternalTransport(transport: ExternalTransport | null): void {
    if (transport === this.externalTransport) return;
    if (!transport && this.externalActive) this.deactivateExternal(true);
    this.externalTransport = transport;
    if (!transport) {
      this.exclusiveFallbackReason = null;
      this.notify();
    }
  }

  setExternalAnalysis(source: ExternalAnalysisSource | null): void {
    this.externalTap = source;
  }

  /** State push channel for the external backend (position/ended/errors). */
  patchExternal(p: Partial<EngineState>): void {
    if (!this.externalActive) return;
    this.patch(p);
  }

  getExclusiveInfo(): ExclusiveInfo {
    return {
      active: this.externalActive,
      negotiated: this.externalActive ? this.exclusiveNegotiated : null,
      fallbackReason: this.exclusiveFallbackReason,
    };
  }

  /** Called by the bridge when the exclusive device vanished mid-play. */
  handleExternalDeviceLost(positionSec: number): void {
    if (!this.externalActive) return;
    this.deactivateExternal(false);
    this.exclusiveFallbackReason = 'Exclusive device lost — playing through the shared path.';
    const { src, trackId } = this.state;
    if (src) {
      // Retry through play(): the external transport gets first refusal (the
      // device may be back), otherwise the deck path picks up seamlessly.
      void this.play(src, trackId, Math.max(0, positionSec)).catch(() => undefined);
    }
  }

  private deactivateExternal(stopBackend: boolean): void {
    this.externalActive = false;
    this.exclusiveNegotiated = null;
    if (stopBackend) {
      try {
        this.externalTransport?.stop();
      } catch {
        /* backend already gone */
      }
    }
  }

  private async tryExternalPlay(
    src: string,
    trackId: number,
    startAt: number,
    seq: number,
  ): Promise<'accepted' | 'declined' | 'stale'> {
    const transport = this.externalTransport;
    if (!transport) return 'declined';
    let accepted = false;
    try {
      accepted = await transport.play(trackId, startAt);
    } catch (err) {
      if (seq !== this.playSeq) return 'stale';
      this.exclusiveFallbackReason = err instanceof Error ? err.message : String(err);
      accepted = false;
    }
    if (seq !== this.playSeq) {
      // A newer play() owns the state now — do not touch anything.
      return 'stale';
    }
    if (!accepted) {
      if (this.externalActive) this.deactivateExternal(true);
      return 'declined';
    }
    // The external backend owns audio now — make sure the decks are silent.
    if (this.graph) {
      for (const deck of this.graph.decks) this.silenceDeck(deck, true);
    }
    this.clearFadeTimer();
    this.preparedNext = null;
    this.externalActive = true;
    this.exclusiveFallbackReason = null;
    this.patch({
      src,
      trackId,
      currentTime: Math.max(0, startAt),
      duration: 0,
      playing: true,
      buffering: false,
      ended: false,
      error: null,
    });
    return 'accepted';
  }

  /** The exclusive bridge records the negotiated format here after a play. */
  setExclusiveNegotiated(negotiated: ExclusiveNegotiated | null): void {
    this.exclusiveNegotiated = negotiated;
    this.notify();
  }

  async play(src: string, trackId: number | null, startAt = 0): Promise<void> {
    const seq = ++this.playSeq;
    // A new play attempt cancels any terminal ended state immediately — the
    // external path resolves asynchronously, and a stuck ended:true across
    // notifies is what let the store's auto-advance re-fire.
    if (this.state.ended) this.patch({ ended: false });
    if (this.externalTransport && trackId != null) {
      const outcome = await this.tryExternalPlay(src, trackId, startAt, seq);
      if (outcome !== 'declined') return;
    } else if (this.externalActive) {
      // Current track is external but the next one can't be (no track id) —
      // release the exclusive device before the deck path starts.
      this.deactivateExternal(true);
    }
    if (seq !== this.playSeq) return;
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
    if (this.externalActive) {
      // Gapless chaining happens in the main process; deck preloading would
      // just double-decode the file for a deck that never plays.
      this.externalTransport?.prepareNext(trackId, normalizeStartAt(startAt));
      return;
    }
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
      this.cancelPendingSeek(deck);
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
    if (Number.isFinite(deck.el.duration) && deck.el.duration > 0) {
      try {
        deck.el.currentTime = Math.max(0, Math.min(deck.el.duration, target));
      } catch {
        /* metadata may not be ready */
      }
      return;
    }
    this.scheduleMetadataSeek(deck, target);
  }

  /**
   * Land a seek once metadata arrives — guarded against the deck's src
   * changing first (prepareNext B then play C on the same deck used to seek C
   * to B's offset), and cancellable via silenceDeck. Mirrors the seekSeq /
   * scheduledSrc guard the VBR diagnostic already uses.
   */
  private scheduleMetadataSeek(deck: Deck, target: number): void {
    this.cancelPendingSeek(deck);
    const scheduledSrc = deck.el.currentSrc;
    const handler = (): void => {
      deck.pendingSeek = null;
      if (deck.el.currentSrc !== scheduledSrc) return; // src changed — stale seek
      try {
        const max = Number.isFinite(deck.el.duration) && deck.el.duration > 0 ? deck.el.duration : target;
        deck.el.currentTime = Math.max(0, Math.min(max, target));
      } catch {
        /* still not seekable (non-seekable stream); nothing more we can do */
      }
    };
    deck.pendingSeek = { handler };
    deck.el.addEventListener('loadedmetadata', handler, { once: true });
  }

  private cancelPendingSeek(deck: Deck): void {
    if (!deck.pendingSeek) return;
    deck.el.removeEventListener('loadedmetadata', deck.pendingSeek.handler);
    deck.pendingSeek = null;
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
    // A successful explicit selection clears any prior auto-fallback notice.
    this.deviceFallback = null;
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

  private registerDeviceChangeListener(): void {
    if (this.deviceChangeHandler) return;
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.addEventListener !== 'function') return;
    const handler = (): void => { void this.handleDeviceChange(); };
    this.deviceChangeHandler = handler;
    md.addEventListener('devicechange', handler);
  }

  private async handleDeviceChange(): Promise<void> {
    try {
      const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
      if (!md || typeof md.enumerateDevices !== 'function' || !this.graph) return;
      const devices = await md.enumerateDevices();
      // dispose() may have torn down the graph during the await; bail before
      // applyOutputDevice → ensureGraph could spawn a zombie AudioContext.
      if (!this.graph) return;
      const outputIds = devices.filter((d) => d.kind === 'audiooutput').map((d) => d.deviceId);
      const plan = planDeviceChange(this.outputDeviceId, outputIds);
      if (plan === 'noop') return;
      if (plan === 'reapply') {
        await this.applyOutputDevice(this.outputDeviceId);
        return;
      }
      // 'fallback': the pinned device vanished — drop to the system default and
      // record it so the Settings UI can surface "output device changed".
      this.deviceFallback = this.outputDeviceId ? { requestedId: this.outputDeviceId } : null;
      this.outputDeviceId = null;
      await this.applyOutputDevice(null);
    } catch (err) {
      // Never let device-change handling throw into the audio path.
      console.warn('[newamp] device-change handling failed', err);
    }
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
    if (this.externalActive) {
      try {
        this.externalTransport?.pause();
      } catch {
        /* surfaced via events */
      }
      this.patch({ playing: false });
      return;
    }
    if (!this.graph) {
      this.patch({ playing: false });
      return;
    }
    for (const deck of this.graph.decks) deck.el.pause();
  }

  togglePlayPause(): void {
    if (this.externalActive) {
      if (this.state.playing) {
        this.pause();
      } else {
        try {
          this.externalTransport?.resume();
        } catch {
          /* surfaced via events */
        }
        this.patch({ playing: true, ended: false });
      }
      return;
    }
    // Re-route through play() (which gives the external transport first
    // refusal) instead of resuming a deck, when either:
    //  - the deck lost its src: Bit-Perfect Exclusive was toggled OFF while
    //    paused (decks were silenced when exclusive engaged), or
    //  - exclusive was toggled ON while a deck track sat paused — the external
    //    path should own the resume, not the deck.
    const coldSrc = this.state.src;
    const deckSrcMissing = !this.graph || !this.activeDeck.el.src;
    const exclusiveShouldTakeOver =
      this.externalTransport != null && !this.externalActive && this.state.trackId != null;
    if (coldSrc && !this.state.playing && (deckSrcMissing || exclusiveShouldTakeOver)) {
      void this.play(coldSrc, this.state.trackId, Math.max(0, this.state.currentTime)).catch(
        () => undefined,
      );
      return;
    }
    if (deckSrcMissing && !coldSrc) return;
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
    if (this.externalActive) {
      this.deactivateExternal(true);
      this.patch({ playing: false, currentTime: 0, ended: false, buffering: false, error: null });
      return;
    }
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
    if (!Number.isFinite(seconds)) return;
    if (this.externalActive) {
      const target = Math.max(0, seconds);
      try {
        this.externalTransport?.seek(target);
      } catch {
        /* surfaced via events */
      }
      this.patch({ currentTime: target });
      return;
    }
    if (!this.graph) return;
    const el = this.activeDeck.el;
    // Only clamp to duration when it is actually known. `el.duration || 0`
    // collapses to 0 whenever duration is NaN/Infinity (custom protocol before
    // metadata, live transcode), which turned every seek into seek-to-zero.
    // Fall back to the raw target and let the element clamp internally.
    const upper = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : Number.POSITIVE_INFINITY;
    const target = Math.max(0, Math.min(upper, seconds));
    const previous = el.currentTime;
    let assigned = false;
    try {
      el.currentTime = target;
      assigned = true;
    } catch (err) {
      // Element not ready to seek yet (readyState < HAVE_METADATA). Mirror
      // applyStartPosition's retry: land the seek once metadata arrives instead
      // of silently dropping it (e.g. resuming a saved position on a cold deck).
      console.warn('[newamp] seek before metadata; retrying on loadedmetadata', err);
      this.scheduleMetadataSeek(this.activeDeck, target);
    }
    // Don't run the VBR-failure diagnostic when the assignment itself threw —
    // the position never changed, so the verify would false-positive "seek
    // failed: VBR MP3" when the real cause was "metadata not ready".
    if (!assigned) return;
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
    // the limiter (see graph wiring), so when the limiter is ENABLED values
    // past 1.0 are caught by it and never reach the device above 0 dBFS. With
    // the limiter bypassed (true off), boost past unity CAN clip at the device
    // — that is the user's explicit choice when they disable clipping protection.
    // `this.volume` keeps the raw slider POSITION (for the % label,
    // persistence, headroom math); the gain node gets a perceptual taper via
    // volumePositionToGain so equal slider travel ~= equal perceived loudness.
    this.volume = Math.max(0, Math.min(2, v));
    if (!this.graph) return;
    this.graph.masterGain.gain.setTargetAtTime(
      volumePositionToGain(this.volume),
      this.graph.ctx.currentTime,
      0.01,
    );
  }

  setReplayGainDb(db: number | null): void {
    const clampedDb = db == null || !Number.isFinite(db) ? 0 : Math.max(-18, Math.min(12, db));
    this.replayGainLinear = Math.pow(10, clampedDb / 20);
    if (!this.graph) return;
    // Short time-constant (~6ms): ReplayGain changes at track boundaries, and a
    // 20ms ramp was audible as a brief loudness "swell" on the first beat. Still
    // smoothed enough to avoid a zipper/click.
    this.graph.replayGain.gain.setTargetAtTime(this.replayGainLinear, this.graph.ctx.currentTime, 0.006);
  }

  setPreampDb(db: number): void {
    this.preampLinear = preampDbToLinear(db);
    if (!this.graph) return;
    // Preamp is a live Settings slider (not a track-boundary one-shot like
    // ReplayGain), so it uses the slider-class time constant that volume/EQ use
    // — a 0.006 ramp made dragging it audibly steppy next to the others.
    this.graph.inputGain.gain.setTargetAtTime(this.preampLinear, this.graph.ctx.currentTime, 0.015);
  }

  /** Requested-vs-actual rate when the device rejected the preferred rate; null otherwise. */
  getSampleRateFallback(): { requested: number; actual: number } | null {
    return this.sampleRateFallback;
  }

  getDeviceFallback(): { requestedId: string } | null {
    return this.deviceFallback;
  }

  setLimiterEnabled(enabled: boolean): void {
    this.limiterEnabled = normalizeLimiterEnabled(enabled);
    if (this.graph) this.applyLimiter(this.graph, this.limiterEnabled);
  }

  private applyLimiter(graph: AudioGraph, enabled: boolean): void {
    const ctx = graph.ctx;
    // TRUE bypass when off: take the DynamicsCompressor out of the path entirely
    // (masterGain → destination) instead of leaving a unity-ratio compressor +
    // its ~6ms lookahead in the chain. Targeted disconnect(target) documents the
    // exact edge severed and stays correct if a future parallel tap is added off
    // masterGain. The whole rewire is guarded: a connect() failure must NEVER
    // leave masterGain unrouted (that would silently mute all playback) — on any
    // error we force the direct masterGain → destination path and surface it.
    const rewire = (): void => {
      try {
        try { graph.masterGain.disconnect(graph.limiter); } catch { /* edge absent */ }
        try { graph.masterGain.disconnect(ctx.destination); } catch { /* edge absent */ }
        try { graph.limiter.disconnect(ctx.destination); } catch { /* edge absent */ }
        if (enabled) {
          // Constants, not ramps — the mute dip below covers the transition, so
          // ramping to a fixed value would be pointless audio-thread churn.
          graph.limiter.threshold.value = -1;
          graph.limiter.knee.value = 0;
          graph.limiter.ratio.value = 20;
          graph.limiter.attack.value = 0.003;
          graph.limiter.release.value = 0.12;
          graph.masterGain.connect(graph.limiter);
          graph.limiter.connect(ctx.destination);
        } else {
          graph.masterGain.connect(ctx.destination);
        }
        this.limiterWired = true;
      } catch (err) {
        console.error('[newamp] limiter rewire failed; forcing direct output to keep audio alive', err);
        try { graph.masterGain.disconnect(); } catch { /* ignore */ }
        try {
          graph.masterGain.connect(ctx.destination);
          this.limiterWired = true;
        } catch (fatal) {
          console.error('[newamp] limiter recovery failed; audio routing is broken', fatal);
          this.patch({ error: 'Audio routing failed — reload NewAmp.' });
        }
      }
    };

    // First wiring (graph boot) or a non-running context: nothing is audible, so
    // rewire directly. On a live, running graph the limited↔raw amplitude step is
    // an instantaneous discontinuity → a click; mute the master across the switch
    // (~8ms down, rewire, ~8ms up) so the toggle is inaudible.
    if (!this.limiterWired || ctx.state !== 'running') {
      rewire();
      return;
    }
    const target = volumePositionToGain(this.volume);
    const DIP_S = 0.008;
    const now = ctx.currentTime;
    graph.masterGain.gain.cancelScheduledValues(now);
    graph.masterGain.gain.setValueAtTime(Math.max(0.0001, graph.masterGain.gain.value), now);
    graph.masterGain.gain.linearRampToValueAtTime(0.0001, now + DIP_S);
    if (this.limiterDipTimer != null) window.clearTimeout(this.limiterDipTimer);
    this.limiterDipTimer = window.setTimeout(() => {
      this.limiterDipTimer = null;
      if (!this.graph) return;
      rewire();
      const t = ctx.currentTime;
      graph.masterGain.gain.cancelScheduledValues(t);
      graph.masterGain.gain.setValueAtTime(0.0001, t);
      graph.masterGain.gain.linearRampToValueAtTime(target, t + DIP_S);
    }, Math.ceil(DIP_S * 1000) + 4);
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

  /**
   * True while the analyser read methods should serve external-tap data: the
   * exclusive backend owns audio, so the Web Audio analysers only see silence.
   */
  private get useExternalAnalysis(): boolean {
    return this.externalActive && this.externalTap != null;
  }

  getFreqData(buf: Uint8Array<ArrayBuffer>): void {
    if (this.useExternalAnalysis) {
      if (this.externalTap!.isFresh()) this.externalTap!.getFreqData(buf);
      else buf.fill(0);
      return;
    }
    if (!this.graph) {
      buf.fill(0);
      return;
    }
    this.graph.analyser.getByteFrequencyData(buf);
  }

  getTimeData(buf: Uint8Array<ArrayBuffer>): void {
    if (this.useExternalAnalysis) {
      if (this.externalTap!.isFresh()) this.externalTap!.getTimeData(buf);
      else buf.fill(128);
      return;
    }
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
    if (this.useExternalAnalysis) {
      if (this.externalTap!.isFresh()) this.externalTap!.getOnsetFreqData(buf);
      else buf.fill(0);
      return;
    }
    if (!this.graph) {
      buf.fill(0);
      return;
    }
    this.graph.onsetAnalyser.getByteFrequencyData(buf);
  }

  /** Per-channel frequency data for the Eviland visualizer's stereo width/pan. */
  getLeftFreqData(buf: Uint8Array<ArrayBuffer>): void {
    if (this.useExternalAnalysis) {
      if (this.externalTap!.isFresh()) this.externalTap!.getLeftFreqData(buf);
      else buf.fill(0);
      return;
    }
    if (!this.graph) {
      buf.fill(0);
      return;
    }
    this.graph.leftAnalyser.getByteFrequencyData(buf);
  }

  getRightFreqData(buf: Uint8Array<ArrayBuffer>): void {
    if (this.useExternalAnalysis) {
      if (this.externalTap!.isFresh()) this.externalTap!.getRightFreqData(buf);
      else buf.fill(0);
      return;
    }
    if (!this.graph) {
      buf.fill(0);
      return;
    }
    this.graph.rightAnalyser.getByteFrequencyData(buf);
  }

  /**
   * Read time-domain samples from the unsmoothed onset-detection analyser.
   * Use this when feeding butterchurn (or any external visualizer) so its
   * internal FFT sees snappy transients instead of the visualizer analyser's
   * 1.3-frame smoothing lag.
   */
  getOnsetTimeData(buf: Uint8Array<ArrayBuffer>): void {
    if (this.useExternalAnalysis) {
      if (this.externalTap!.isFresh()) this.externalTap!.getOnsetTimeData(buf);
      else buf.fill(128);
      return;
    }
    if (!this.graph) {
      buf.fill(128);
      return;
    }
    this.graph.onsetAnalyser.getByteTimeDomainData(buf);
  }

  /** Current audio sample rate in Hz, or null when the engine has not booted. */
  getSampleRate(): number {
    if (this.useExternalAnalysis) return this.externalTap!.getSampleRate();
    return this.graph?.ctx.sampleRate ?? 48000;
  }

  dispose(): void {
    this.clearFadeTimer();
    if (this.limiterDipTimer != null) {
      window.clearTimeout(this.limiterDipTimer);
      this.limiterDipTimer = null;
    }
    this.limiterWired = false;
    this.stopTick();
    if (this.deviceChangeHandler && typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.deviceChangeHandler);
    }
    this.deviceChangeHandler = null;
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
