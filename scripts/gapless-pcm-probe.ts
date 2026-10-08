// Renderer half of scripts/gapless-pcm-boundary-test.mjs. Drives the real
// AudioEngine — through the decks, or through the real SampleTransport over
// the real preload and gapless IPC — plays scripted queues the way the store
// does (play the next track when the engine reports `ended`), and records the
// graph's final output with a capture worklet on the master gain.

import { AudioEngine, type EngineState } from '../src/audio/engine';
import { SampleTransport } from '../src/audio/sample-transport';

interface Fixture {
  id: number;
  path: string;
}

type CaseKind =
  | 'chain'
  | 'replaygain'
  | 'device'
  | 'pause'
  | 'seek'
  | 'skip'
  | 'rapid'
  | 'stop'
  | 'corrupt'
  | 'revoke'
  | 'handoff'
  | 'startrace'
  | 'park'
  | 'shortb'
  | 'pending'
  | 'chain3'
  | 'longbp';

interface CaseSpec {
  name: string;
  kind: CaseKind;
  transport: boolean;
  rate: number;
  a: Fixture;
  b?: Fixture;
  c?: Fixture;
  aDuration: number;
  bDuration?: number;
  cDuration?: number;
  gainDb?: number;
}

interface EventRecord {
  frame: number;
  trackId: number | null;
  ended: boolean;
  playing: boolean;
  error: string | null;
}

declare global {
  interface Window {
    toAudioUrl(path: string): string;
    __gaplessProbe: { run(spec: CaseSpec): Promise<unknown> };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function url(fixture: Fixture): string {
  return window.toAudioUrl(fixture.path);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms)),
  ]);
}

function toBase64(data: Float32Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

class Capture {
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private waiters = new Map<string, (data: { frame: number; maxChannelDiff?: number }) => void>();
  startFrame = 0;
  maxChannelDiff = 0;
  readonly marks: Record<string, number> = {};

  async attach(ctx: AudioContext, source: AudioNode): Promise<void> {
    await ctx.audioWorklet.addModule(new URL('./gapless-pcm-capture.js', import.meta.url));
    const node = new AudioWorkletNode(ctx, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    node.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as { t: string; pcm?: Float32Array; frame?: number; maxChannelDiff?: number; name?: string; index?: number };
      if (msg.t === 'pcm' && msg.pcm) this.chunks.push(msg.pcm);
      else if (msg.t === 'marked' && msg.name) this.marks[msg.name] = msg.index ?? 0;
      else this.waiters.get(msg.t)?.({ frame: msg.frame ?? 0, maxChannelDiff: msg.maxChannelDiff });
    };
    source.connect(node);
    // A worklet nobody pulls is never processed; a muted edge to the
    // destination keeps it rendering without adding anything audible.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);
    this.node = node;
  }

  mark(name: string): void {
    this.node?.port.postMessage({ t: 'mark', name });
  }

  async start(): Promise<void> {
    const started = new Promise<{ frame: number }>((resolve) => this.waiters.set('started', resolve));
    this.node!.port.postMessage('start');
    this.startFrame = (await started).frame;
  }

  async stop(): Promise<Float32Array> {
    const stopped = new Promise<{ frame: number; maxChannelDiff?: number }>((resolve) => this.waiters.set('stopped', resolve));
    this.node!.port.postMessage('stop');
    this.maxChannelDiff = (await stopped).maxChannelDiff ?? 0;
    const total = this.chunks.reduce((n, chunk) => n + chunk.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.node!.disconnect();
    return out;
  }
}

/**
 * The store's automatic advance, reduced to what the engine sees: when the
 * engine reports `ended` for the track at the head of `queue`, set the next
 * track's ReplayGain and play it on a 0 ms timer (or after `delays[index]`
 * ms, a busy renderer), then prepare the one after.
 */
function followQueue(engine: AudioEngine, queue: Fixture[], gains: Array<number | null> = [], delays: Record<number, number> = {}) {
  let index = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const errors: string[] = [];
  const unsubscribe = engine.subscribe((state) => {
    if (index >= queue.length || !state.ended || state.trackId !== queue[index]!.id) return;
    index += 1;
    if (index >= queue.length) {
      resolveDone();
      return;
    }
    const next = queue[index]!;
    const nextIndex = index;
    setTimeout(() => {
      engine.setReplayGainDb(gains[nextIndex] ?? null);
      engine.play(url(next), next.id, 0).then(
        () => {
          const after = queue[nextIndex + 1];
          if (after) engine.prepareNext(url(after), after.id, 0, gains[nextIndex + 1] ?? null);
        },
        (err: unknown) => errors.push(String(err)),
      );
    }, delays[nextIndex] ?? 0);
  });
  return { done, errors, unsubscribe };
}

async function waitForPosition(engine: AudioEngine, seconds: number, timeoutMs: number): Promise<void> {
  const started = performance.now();
  while (engine.getPlaybackPosition() < seconds) {
    if (performance.now() - started > timeoutMs) throw new Error(`position never reached ${seconds}s`);
    await sleep(10);
  }
}

async function waitForTrack(engine: AudioEngine, trackId: number, seconds: number, timeoutMs: number): Promise<void> {
  const started = performance.now();
  while (engine.getState().trackId !== trackId || engine.getPlaybackPosition() < seconds) {
    if (performance.now() - started > timeoutMs) throw new Error(`track ${trackId} never reached ${seconds}s`);
    await sleep(10);
  }
}

async function run(spec: CaseSpec): Promise<unknown> {
  const engine = new AudioEngine();
  engine.setPreferredSampleRate(spec.rate);
  engine.setLimiterEnabled(false);
  engine.setVolume(1);
  engine.setEqEnabled(false);
  const transport = spec.transport ? new SampleTransport() : null;
  if (transport) engine.setSampleTransport(transport);
  // Internals a few cases observe: whether a paused stream was released, and
  // the worklet's own queue reports.
  const internals = transport as unknown as { parkedAt: number | null; node: AudioWorkletNode | null } | null;
  const ctx = engine.ctx;
  await ctx.resume();
  // A fresh context takes a while to start rendering; start-latency numbers
  // only mean something once it is running.
  while (ctx.currentTime < 0.25) await sleep(20);
  const capture = new Capture();
  await capture.attach(ctx, engine.masterGain);
  const frameNow = () => Math.round(ctx.currentTime * ctx.sampleRate);
  const events: EventRecord[] = [];
  let lastKey = '';
  const unsubscribeEvents = engine.subscribe((state: EngineState) => {
    const key = `${state.trackId}|${state.ended}|${state.playing}|${state.error}`;
    if (key === lastKey) return;
    lastKey = key;
    events.push({ frame: frameNow(), trackId: state.trackId, ended: state.ended, playing: state.playing, error: state.error });
  });
  const marks: Record<string, number> = {};
  const extra: Record<string, unknown> = {};
  const mark = (name: string) => {
    marks[name] = frameNow();
    capture.mark(name);
  };
  const { a, b, c } = spec;
  const aMs = spec.aDuration * 1000;
  const chainMs = (spec.aDuration + (spec.bDuration ?? 0)) * 1000 + 8000;
  await capture.start();
  let failure: string | null = null;
  try {
    switch (spec.kind) {
      case 'chain':
      case 'replaygain':
      case 'device': {
        const gains = spec.kind === 'replaygain' ? [0, spec.gainDb ?? -6] : [];
        const queue = followQueue(engine, [a, b!], gains);
        engine.setReplayGainDb(gains[0] ?? null);
        mark('play');
        await engine.play(url(a), a.id, 0);
        await sleep(200);
        engine.prepareNext(url(b!), b!.id, 0, gains[1] ?? null);
        if (spec.kind === 'device') {
          const outputs = (await navigator.mediaDevices.enumerateDevices())
            .filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
          extra.outputDevices = outputs.length;
          await sleep(600);
          if (outputs[0]) {
            mark('device-switch');
            await engine.setOutputDevice(outputs[0].deviceId);
            await sleep(800);
            mark('device-restore');
            await engine.setOutputDevice(null);
          }
        }
        await withTimeout(queue.done, chainMs, 'chain end');
        extra.advanceErrors = queue.errors;
        queue.unsubscribe();
        break;
      }
      case 'pause': {
        mark('play');
        await engine.play(url(a), a.id, 0);
        await sleep(1200);
        engine.pause();
        mark('pause');
        extra.positionAtPause = engine.getPlaybackPosition();
        await sleep(700);
        extra.positionWhilePaused = engine.getPlaybackPosition();
        extra.stateTimeWhilePaused = engine.getState().currentTime;
        engine.togglePlayPause();
        mark('resume');
        await sleep(1200);
        engine.stop();
        mark('stop');
        await sleep(200);
        break;
      }
      case 'seek': {
        const queue = followQueue(engine, [a, b!]);
        mark('play');
        await engine.play(url(a), a.id, 0);
        await sleep(200);
        engine.prepareNext(url(b!), b!.id, 0, null);
        await sleep(1100);
        extra.seekTarget = spec.aDuration - 0.8;
        mark('seek');
        engine.seek(spec.aDuration - 0.8);
        await withTimeout(queue.done, chainMs, 'seek chain end');
        queue.unsubscribe();
        break;
      }
      case 'skip': {
        mark('play');
        await engine.play(url(a), a.id, 0);
        await sleep(200);
        engine.prepareNext(url(b!), b!.id, 0, null);
        await waitForPosition(engine, spec.aDuration - 0.6, aMs + 3000);
        const queue = followQueue(engine, [c!]);
        mark('skip');
        await engine.play(url(c!), c!.id, 0);
        await withTimeout(queue.done, (spec.cDuration ?? 3) * 1000 + 6000, 'skip end');
        queue.unsubscribe();
        break;
      }
      case 'rapid': {
        mark('play');
        await engine.play(url(a), a.id, 0);
        await sleep(800);
        engine.prepareNext(url(b!), b!.id, 0, null);
        mark('rapid');
        const outcomes = await Promise.all([
          engine.play(url(b!), b!.id, 0),
          engine.play(url(c!), c!.id, 0),
          engine.play(url(a), a.id, 0),
        ]);
        extra.outcomes = outcomes;
        await sleep(1500);
        extra.finalTrackId = engine.getState().trackId;
        engine.stop();
        mark('stop');
        await sleep(200);
        break;
      }
      case 'stop': {
        mark('play');
        await engine.play(url(a), a.id, 0);
        await sleep(1000);
        engine.stop();
        mark('stop');
        extra.stateAfterStop = { ...engine.getState() };
        await sleep(500);
        engine.togglePlayPause();
        mark('restart');
        await sleep(1500);
        engine.stop();
        mark('stop2');
        await sleep(200);
        break;
      }
      case 'corrupt': {
        mark('play');
        await engine.play(url(a), a.id, 0);
        await sleep(200);
        engine.prepareNext(url(b!), b!.id, 0, null);
        await withTimeout(
          new Promise<void>((resolve) => {
            const off = engine.subscribe((state) => {
              if (state.ended && state.trackId === a.id) {
                off();
                resolve();
              }
            });
          }),
          aMs + 5000,
          'corrupt boundary',
        );
        mark('boundary');
        extra.fallbackAtBoundary = engine.getSampleTransportInfo().fallbackReason;
        try {
          extra.corruptOutcome = await engine.play(url(b!), b!.id, 0);
        } catch (err) {
          extra.corruptError = String(err);
        }
        await sleep(350);
        extra.stateAfterCorrupt = { ...engine.getState() };
        mark('recover');
        await engine.play(url(c!), c!.id, 0);
        extra.recoveredOnTransport = engine.getSampleTransportInfo().active;
        await sleep(1500);
        // A corrupt file started directly (not chained): the transport's
        // start fails, the decks get it, and the error surfaces the same way.
        try {
          extra.directOutcome = await engine.play(url(b!), b!.id, 0);
        } catch (err) {
          extra.directError = String(err);
        }
        extra.directFallback = engine.getSampleTransportInfo().fallbackReason;
        extra.directActive = engine.getSampleTransportInfo().active;
        engine.stop();
        mark('stop');
        await sleep(200);
        break;
      }
      case 'handoff': {
        mark('play');
        await engine.play(url(a), a.id, 0);
        await sleep(1000);
        extra.activeBefore = engine.getSampleTransportInfo().active;
        extra.handoffAt = engine.getPlaybackPosition();
        mark('handoff');
        // Crossfade needs overlapping decks; the playing track moves to one.
        engine.setCrossfadeMs(2000);
        await sleep(1200);
        extra.activeAfter = engine.getSampleTransportInfo().active;
        extra.stateAfter = { ...engine.getState() };
        engine.stop();
        mark('stop');
        await sleep(200);
        break;
      }
      case 'startrace': {
        // seek() issued synchronously after play(), before the transport has
        // a stream: the start must land on the seek target.
        mark('play');
        const seekPlay = engine.play(url(a), a.id, 0);
        engine.seek(2);
        extra.seekOutcome = await seekPlay;
        extra.seekActive = engine.getSampleTransportInfo().active;
        extra.seekState = { ...engine.getState() };
        await sleep(800);
        engine.stop();
        mark('stop');
        await sleep(300);
        // pause() issued the same way: nothing may play until resumed.
        const pausePlay = engine.play(url(a), a.id, 0);
        engine.pause();
        extra.pauseOutcome = await pausePlay;
        await sleep(500);
        extra.pausedState = { ...engine.getState() };
        mark('resume');
        engine.togglePlayPause();
        await sleep(800);
        engine.stop();
        mark('stop2');
        await sleep(200);
        break;
      }
      case 'revoke': {
        const queue = followQueue(engine, [a, c!]);
        mark('play');
        await engine.play(url(a), a.id, 0);
        await sleep(200);
        engine.prepareNext(url(b!), b!.id, 0, null);
        await waitForPosition(engine, spec.aDuration - 1.5, aMs + 3000);
        mark('revoke');
        engine.prepareNext(url(c!), c!.id, 0, null);
        await withTimeout(queue.done, (spec.aDuration + (spec.cDuration ?? 3)) * 1000 + 8000, 'revoke end');
        queue.unsubscribe();
        break;
      }
      case 'park': {
        // Paused past the transport's release delay: the decoder is let go
        // and resume restarts it where playback stopped.
        mark('play');
        await engine.play(url(a), a.id, 0);
        await sleep(1200);
        engine.pause();
        mark('pause');
        await sleep(5600);
        extra.released = internals?.parkedAt != null;
        extra.positionWhilePaused = engine.getPlaybackPosition();
        engine.togglePlayPause();
        mark('resume');
        await sleep(1200);
        engine.stop();
        mark('stop');
        await sleep(200);
        break;
      }
      case 'shortb': {
        // B is 50 ms and the queue gets to it 250 ms after the boundary, when
        // it has already played out.
        const queue = followQueue(engine, [a, b!, c!], [], { 1: 250 });
        mark('play');
        await engine.play(url(a), a.id, 0);
        await sleep(200);
        engine.prepareNext(url(b!), b!.id, 0, null);
        await withTimeout(queue.done, chainMs + (spec.cDuration ?? 3) * 1000, 'short chained track end');
        queue.unsubscribe();
        break;
      }
      case 'pending': {
        // The next track is prepared while the first one's start is still
        // being planned in main (its library lookup is slow).
        const queue = followQueue(engine, [a, b!]);
        mark('play');
        const playing = engine.play(url(a), a.id, 0);
        for (let i = 0; i < 2000 && !engine.isSampleTransportActive(); i++) await sleep(1);
        engine.prepareNext(url(b!), b!.id, 0, null);
        await playing;
        await withTimeout(queue.done, chainMs, 'pending chain end');
        queue.unsubscribe();
        break;
      }
      case 'chain3': {
        const queue = followQueue(engine, [a, b!, c!]);
        mark('play');
        await engine.play(url(a), a.id, 0);
        await sleep(200);
        engine.prepareNext(url(b!), b!.id, 0, null);
        // What the signal-path readout reports for each track while it plays.
        await waitForTrack(engine, a.id, 1, aMs + 3000);
        extra.infoA = engine.getSampleTransportInfo();
        await waitForTrack(engine, b!.id, 1, chainMs);
        extra.infoB = engine.getSampleTransportInfo();
        await waitForTrack(engine, c!.id, 1, chainMs + 4000);
        extra.infoC = engine.getSampleTransportInfo();
        await withTimeout(queue.done, chainMs + 4000, 'three-track chain end');
        queue.unsubscribe();
        break;
      }
      case 'longbp': {
        // How far ahead of the playhead the producer runs with a 60 s track
        // chained: the worklet's own count of frames it holds.
        const queue = followQueue(engine, [a, b!]);
        mark('play');
        await engine.play(url(a), a.id, 0);
        let maxQueued = 0;
        const onReport = (event: MessageEvent) => {
          const msg = event.data as { t?: string; queued?: number };
          if (msg.t === 'pos' && typeof msg.queued === 'number') maxQueued = Math.max(maxQueued, msg.queued);
        };
        const port = internals?.node?.port ?? null;
        port?.addEventListener('message', onReport);
        engine.prepareNext(url(b!), b!.id, 0, null);
        await waitForTrack(engine, b!.id, 4, aMs + 10000);
        port?.removeEventListener('message', onReport);
        extra.maxQueuedFrames = maxQueued;
        queue.unsubscribe();
        engine.stop();
        mark('stop');
        await sleep(200);
        break;
      }
    }
    await sleep(300);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  const pcm = await capture.stop();
  const info = engine.getSampleTransportInfo();
  unsubscribeEvents();
  engine.dispose();
  return {
    name: spec.name,
    rate: ctx.sampleRate,
    captureStartFrame: capture.startFrame,
    captureMarks: capture.marks,
    maxChannelDiff: capture.maxChannelDiff,
    frames: pcm.length,
    pcm: toBase64(pcm),
    events,
    marks,
    info,
    extra,
    failure,
  };
}

window.__gaplessProbe = { run };
