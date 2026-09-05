// Renderer half of Bit-Perfect Exclusive mode.
//
// Implements the engine's ExternalTransport over IPC: transport calls go to
// electron/exclusive-output.ts, and its events (position/ended/boundary/
// error/device-lost) come back and are pushed into the engine's normal state
// pipeline via patchExternal(), so the store and every consumer behave as if
// a deck were playing. The 30Hz PCM tap feeds an ExternalAnalysisTap so all
// visualizers (including the detached projector) stay live while the Web
// Audio graph is silent.

import { api } from '../lib/api';
import { ExternalAnalysisTap } from './exclusive-tap';
import type { AudioEngine, ExternalTransport } from './engine';
import type { ExclusiveEventPayload } from '@shared/types';

class ExclusiveBridge implements ExternalTransport {
  private engine: AudioEngine | null = null;
  private readonly tap = new ExternalAnalysisTap();
  private unsubEvent: (() => void) | null = null;
  private unsubTap: (() => void) | null = null;
  private enabled = false;
  private supported: boolean | null = null;
  // Last state the caller ASKED for. setEnabled awaits a support probe, so a
  // rapid enable→disable could otherwise be overridden by the in-flight
  // enable finishing late.
  private desired = false;
  // Set when ended/boundary was forwarded; stray position events for the
  // terminal stream must not re-notify the store against a stuck ended state.
  private endedPending = false;
  private playSeq = 0;

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Attach or detach the exclusive backend. Returns whether it ended up
   * enabled (false when the platform/addon doesn't support it).
   */
  async setEnabled(engine: AudioEngine, enabled: boolean): Promise<boolean> {
    this.engine = engine;
    this.desired = enabled;
    if (enabled === this.enabled) return this.enabled;
    if (!enabled) {
      this.teardown();
      return false;
    }
    if (this.supported == null) {
      try {
        this.supported = await api.exclusiveSupported();
      } catch {
        this.supported = false;
      }
    }
    if (!this.supported) return false;
    if (!this.desired) return this.enabled; // disabled while the probe ran
    this.enabled = true;
    engine.setExternalAnalysis(this.tap);
    engine.setExternalTransport(this);
    this.unsubEvent = api.onExclusiveEvent((payload) => this.onEvent(payload));
    this.unsubTap = api.onExclusiveTap((tap) => this.tap.feed(tap.pcm, tap.channels, tap.sampleRate));
    return true;
  }

  private teardown(): void {
    this.enabled = false;
    this.playSeq++;
    this.unsubEvent?.();
    this.unsubEvent = null;
    this.unsubTap?.();
    this.unsubTap = null;
    this.engine?.setExternalTransport(null);
    this.engine?.setExternalAnalysis(null);
    void api.exclusiveStop().catch(() => undefined);
  }

  // ---- ExternalTransport ----------------------------------------------------

  async play(trackId: number, startAt: number): Promise<boolean> {
    const seq = ++this.playSeq;
    const result = await api.exclusivePlay(trackId, startAt);
    if (seq !== this.playSeq || !this.enabled) return false;
    if (!result.ok) {
      // Throw so the engine records the honest fallback reason before it
      // routes this track through the normal deck path.
      throw new Error(result.error || 'Exclusive playback failed.');
    }
    this.endedPending = false;
    this.engine?.setExclusiveNegotiated(result.negotiated ?? null);
    // A chained (gapless) ack means the stream never stopped — zeroing the
    // tap there would visibly blink every visualizer at each track boundary.
    if (!result.chained) this.tap.silence();
    return true;
  }

  pause(): void {
    void api.exclusivePause().catch(() => undefined);
  }

  resume(): void {
    void api.exclusiveResume().catch(() => undefined);
  }

  stop(): void {
    this.playSeq++;
    this.tap.silence();
    void api.exclusiveStop().catch(() => undefined);
  }

  seek(seconds: number): void {
    void api.exclusiveSeek(seconds).catch(() => undefined);
  }

  prepareNext(trackId: number | null, startAt: number): void {
    // Cue-sheet segments start mid-file; a chained splice always starts the
    // next stream at 0, so those must NOT chain — they take the reopen path.
    const chainable = trackId != null && startAt <= 0.01 ? trackId : null;
    void api.exclusivePrepareNext(chainable).catch(() => undefined);
  }

  // ---- events from the main-process driver ----------------------------------

  private onEvent(payload: ExclusiveEventPayload): void {
    const engine = this.engine;
    if (!engine || !this.enabled) return;
    switch (payload.type) {
      case 'position':
        // A terminal stream's straggler position events must not re-notify
        // the store while ended:true sits in the merged engine state — that
        // was the cascading-queue-advance bug.
        if (this.endedPending) break;
        engine.patchExternal({
          currentTime: payload.positionSec,
          ...(payload.durationSec && payload.durationSec > 0 ? { duration: payload.durationSec } : {}),
        });
        break;
      case 'state':
        this.endedPending = false;
        engine.patchExternal({
          playing: payload.playing,
          ...(payload.durationSec && payload.durationSec > 0 ? { duration: payload.durationSec } : {}),
        });
        break;
      case 'boundary':
      case 'ended':
        // Mirrors the deck 'ended' DOM event: the store's subscribe callback
        // advances the queue and calls play(next) — which the main driver
        // acks as chained (gapless) or starts fresh.
        this.endedPending = true;
        engine.patchExternal({ playing: false, ended: true });
        break;
      case 'error':
        engine.patchExternal({ playing: false, buffering: false, error: payload.message });
        break;
      case 'device-lost':
        engine.handleExternalDeviceLost(payload.positionSec);
        break;
    }
  }
}

export const exclusiveBridge = new ExclusiveBridge();
