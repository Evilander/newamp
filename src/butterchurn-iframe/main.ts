// Sandboxed Butterchurn host. Runs inside butterchurn-iframe.html, which is the
// only frame whose CSP permits 'unsafe-eval' (butterchurn-presets compiles
// MilkDrop math via the Function constructor). The parent renderer posts raw
// time-domain audio bytes; we drive butterchurn.render({ audioLevels }) with
// them so no Web Audio node has to cross the iframe boundary.
import {
  BUTTERCHURN_FFT_SIZE,
  type BcFrameMessage,
  type BcParentMessage,
} from './protocol';
import { retuneButterchurnBands } from './band-tuning';
import { applyConfig, createActivityTracker, fitCanvasSize, paintsFromMessage, type HostConfig } from './host-policy';
import { createEvilandLivePipeline, type LiveCompositionFrame } from '../visualizer/eviland-live-pipeline';
import { createLivePresetLoader } from '../visualizer/eviland-live-presets';
import { hashSeed } from '../visualizer/eviland-rng';
import { createGovernor } from '../visualizer/eviland-governor';
import { attachFlashGuard, type AttachedFlashGuard } from '../visualizer/flash-guard-host';
import { createCadenceGate, measureDisplayRefresh, requestPacedFrame } from '../lib/pacedFrame';

interface ButterchurnVisualizer {
  loadPreset(preset: Record<string, unknown>, blendSeconds?: number): void;
  render(opts?: {
    audioLevels?: {
      timeByteArray: Uint8Array;
      timeByteArrayL: Uint8Array;
      timeByteArrayR: Uint8Array;
    };
  }): void;
  setRendererSize(width: number, height: number): void;
}

const canvas = document.getElementById('bc') as HTMLCanvasElement | null;

function post(message: BcFrameMessage): void {
  parent.postMessage(message, '*');
}

function unwrapDefault<T>(module: unknown): T {
  const first = (module as { default?: unknown }).default ?? module;
  return ((first as { default?: unknown }).default ?? first) as T;
}

// A static estimate of equation/allocation work and shape/wave complexity.
// Eviland Live separately prepares GPU programs before switching; this bias
// still avoids routinely pairing the most expensive presets with its sources.
function presetSwitchCost(preset: Record<string, unknown>): number {
  const countEnabled = (arr: unknown): number => {
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const item of arr) {
      const enabled = (item as { baseVals?: { enabled?: number } })?.baseVals?.enabled;
      if (enabled != null && Number(enabled) !== 0) n += 1;
    }
    return n;
  };
  const shapes = countEnabled((preset as { shapes?: unknown }).shapes);
  const waves = countEnabled((preset as { waves?: unknown }).waves);
  let cost = (shapes + waves) * 100_000; // each enabled voice owns a megabuffer
  try { cost += JSON.stringify(preset).length; } catch { /* circular — ignore */ }
  return cost;
}

// Butterchurn rejects rates outside this range (its audio context is offline
// and exists only to report a rate), so a rate is clamped before it is used.
function clampRate(sampleRate: number): number {
  return Math.max(8000, Math.min(96000, Math.round(sampleRate) || 44100));
}

let visualizer: ButterchurnVisualizer | null = null;
// Photosensitivity limiter on every frame this canvas shows, plain MilkDrop
// and Eviland Live alike, in the main window and the projector. It follows
// the Settings toggle through this origin's localStorage.
let flashGuard: AttachedFlashGuard | null = null;
let liveMode = false;
// What the parent last said about the display, the tier and the sample rate.
// Changes after init arrive as 'config' messages.
const hostConfig: HostConfig = { dpr: 1, maxPixels: Infinity, quality: 'high', sampleRate: 44100 };
let livePipeline: ReturnType<typeof createEvilandLivePipeline> = null;
// Compiles the next preset's shaders without stalling the page, for plain
// MilkDrop rotation and Eviland Live alike. Null when Butterchurn's renderer
// is not shaped the way it expects, and presets then load synchronously.
let livePresetLoader: ReturnType<typeof createLivePresetLoader> = null;
let latestComposition: LiveCompositionFrame | null = null;
// Seconds Butterchurn blends two presets when the Live Director changes look.
const LIVE_BLEND_SECONDS = 4.5;
let loadLivePreset: (() => void) | null = null;
let rebuildLivePipeline: (() => void) | null = null;
let lastCompositionKey = '';
let presets: Array<[string, Record<string, unknown>]> = [];
// Equation and shader source length provide a cheap preset-cost estimate.
// Rotation usually picks from the lighter half, with occasional heavier looks.
// Live prepares GPU programs separately; their compile/location queries were
// the dominant measured switch cost, beyond equation construction alone.
let presetWeights: number[] = [];
let presetOrder: number[] = [];
let lastAudioPostAt = 0;
let presetTimer: number | null = null;
let cancelFrame: () => void = () => {};
// One paint at the governed cadence, if one is due. Driven by the paced
// animation-frame loop and by the audio message handler (see
// paintsFromMessage). Returns whether it painted.
let paintTick: (() => boolean) | null = null;
// performance.now() of the last animation frame this loop ran in. While they
// keep arriving the compositor is presenting this page.
let lastFrameAt = 0;
let mountedAt = 0;
let disposed = false;
let started = false;
let haveAudio = false;
let pageVisible = typeof document === 'undefined' ? true : !document.hidden;
const latestTime = new Uint8Array(BUTTERCHURN_FFT_SIZE);

// ── Self-governance ─────────────────────────────────────────────────────────
// This loop used to render on every rAF tick — the monitor's full refresh
// rate. On a 144Hz display that's 3–5x more MilkDrop work than the parent's
// 30–45fps paint cadence can even show, and it kept burning at full rate
// while playback was paused. Now: a 45fps cap while audio is live, a 20fps
// idle glide once the track has been quiet for a few seconds (the parent keeps
// posting flatline bytes while paused, so "no messages" never fires), and a
// measured-cost governor that steps the render DPR down when this machine
// can't hold the cadence.
let lastPaintAt = 0;
const IDLE_AFTER_MS = 3000;
const LIVE_FRAME_MS = 1000 / 45;
const IDLE_FRAME_MS = 1000 / 20;
const activity = createActivityTracker(IDLE_AFTER_MS);
// MilkDrop is the star of this mode — give it a bigger budget than the
// overlay layers get in the parent before trimming resolution.
const gov = createGovernor({ costBudgetMs: 10 });
const cadence = createCadenceGate(() =>
  gov.intervalMs(activity.idle(performance.now()) ? IDLE_FRAME_MS : LIVE_FRAME_MS),
);

function sizeCanvas(): void {
  if (!canvas) return;
  const { width: w, height: h } = fitCanvasSize(
    canvas.clientWidth || 640,
    canvas.clientHeight || 360,
    hostConfig.dpr,
    hostConfig.maxPixels,
    gov.scale(),
  );
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    visualizer?.setRendererSize(w, h);
  }
}

async function start(): Promise<void> {
  if (started || disposed || !canvas) return;
  started = true;
  try {
    // The FULL MilkDrop catalog: base + Extra + Extra2 + MD1 packs (~700
    // presets vs ~170 base-only). Extra packs load best-effort — a missing
    // pack must never take down the visualizer, so each settles separately.
    const [butterchurnModule, presetModule, ...extraPackResults] = await Promise.allSettled([
      import('butterchurn'),
      import('butterchurn-presets'),
      import('butterchurn-presets/lib/butterchurnPresetsExtra.min.js'),
      import('butterchurn-presets/lib/butterchurnPresetsExtra2.min.js'),
      import('butterchurn-presets/lib/butterchurnPresetsMD1.min.js'),
    ]);
    if (disposed) return;
    if (butterchurnModule.status !== 'fulfilled' || presetModule.status !== 'fulfilled') {
      throw (butterchurnModule.status === 'rejected' ? butterchurnModule.reason : (presetModule as PromiseRejectedResult).reason);
    }
    const butterchurn = unwrapDefault<{
      createVisualizer(
        context: BaseAudioContext,
        canvas: HTMLCanvasElement,
        opts: Record<string, unknown>,
      ): ButterchurnVisualizer;
    }>(butterchurnModule.value);
    const presetApi = unwrapDefault<{ getPresets(): Record<string, Record<string, unknown>> }>(presetModule.value);
    const presetCatalog: Record<string, Record<string, unknown>> = { ...presetApi.getPresets() };
    for (const pack of extraPackResults) {
      if (pack.status !== 'fulfilled') continue;
      try {
        const packApi = unwrapDefault<{ getPresets(): Record<string, Record<string, unknown>> }>(pack.value);
        // Base pack wins name collisions — insertion order keeps its entries.
        for (const [name, preset] of Object.entries(packApi.getPresets())) {
          if (!(name in presetCatalog)) presetCatalog[name] = preset;
        }
      } catch {
        /* malformed pack — skip */
      }
    }

    // OfflineAudioContext purely supplies sampleRate + analyser nodes for
    // butterchurn's AudioProcessor. It is never started and grabs no device;
    // we feed audio via render({ audioLevels }) so its analyser is unused.
    const OfflineCtx =
      window.OfflineAudioContext ||
      (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    // The rate may have changed while the catalog loaded, before there was a
    // renderer to retune.
    const rate = clampRate(hostConfig.sampleRate);
    const audioCtx = new OfflineCtx(1, rate, rate);

    sizeCanvas();
    if (canvas.width < 8 || canvas.height < 8) {
      canvas.width = 640;
      canvas.height = 360;
    }

    visualizer = butterchurn.createVisualizer(audioCtx, canvas, {
      width: canvas.width,
      height: canvas.height,
      // Lowered from 32x24: fewer warp-mesh vertices means less per-frame pixel-
      // equation work AND a smaller per-load warpUV buffer, both of which feed
      // the inter-preset hitch. Visually near-identical at typical window sizes.
      meshWidth: 24,
      meshHeight: 18,
    });
    // Same context Butterchurn just created. A MilkDrop that can't be
    // guarded doesn't run: the parent's guarded 2D fallback takes over, and
    // Butterchurn's context is released rather than left alive in a frame
    // the parent hides.
    const context = canvas.getContext('webgl2');
    flashGuard = attachFlashGuard(context, canvas);
    if (!flashGuard) {
      visualizer = null;
      context?.getExtension('WEBGL_lose_context')?.loseContext();
      throw new Error('flash guard unavailable in this WebGL2 context');
    }

    presets = Object.entries(presetCatalog).filter(
      (entry): entry is [string, Record<string, unknown>] => !!entry[1] && typeof entry[1] === 'object',
    );
    if (!presets.length) throw new Error('No Butterchurn presets loaded');

    // Prefer fewer enabled shapes/waves, using source length as a tiebreaker.
    presetWeights = presets.map(([, preset]) => presetSwitchCost(preset));
    presetOrder = presets.map((_, i) => i).sort((a, b) => presetWeights[a]! - presetWeights[b]!);

    // Pick a preset, biased toward the lighter half. ~85% from the light half,
    // ~15% from the heavy half so the rotation still surprises you with the
    // dramatic presets occasionally.
    const pickIndex = (): number => {
      const halfBoundary = Math.floor(presetOrder.length / 2);
      const fromLight = Math.random() < 0.85;
      const lo = fromLight ? 0 : halfBoundary;
      const hi = fromLight ? Math.max(1, halfBoundary) : presetOrder.length;
      return presetOrder[lo + Math.floor(Math.random() * (hi - lo))]!;
    };

    // Loads at once, compiling on this thread. For the first preset (nothing
    // is on screen yet) and as the recovery when the asynchronous loader's
    // switch fails half way.
    const loadRandomPreset = (blendSeconds: number): void => {
      if (disposed || !visualizer) return;
      const [, preset] = presets[pickIndex()]!;
      try { visualizer.loadPreset(preset, blendSeconds); } catch { /* bad preset, skip */ }
    };
    // Rotation: the loader compiles the next preset's shaders without
    // stalling the page while the current one keeps drawing, and the paint
    // loop adopts it once it is ready. A warp and comp compile on the page's
    // own thread freezes the UI for tens to hundreds of ms.
    let rotationSerial = 0;
    const rotateToRandomPreset = (blendSeconds: number): void => {
      if (disposed || !visualizer) return;
      if (!livePresetLoader) {
        loadRandomPreset(blendSeconds);
        return;
      }
      const [name, preset] = presets[pickIndex()]!;
      livePresetLoader.request(preset, `${name}#${rotationSerial++}`, blendSeconds);
    };
    livePresetLoader = createLivePresetLoader(visualizer, () => loadRandomPreset(LIVE_BLEND_SECONDS));
    if (liveMode) {
      livePipeline = createEvilandLivePipeline(visualizer, hostConfig.quality);
      if (!livePipeline) {
        // Butterchurn's private renderer isn't shaped the way the adapter
        // expects. Plain MilkDrop with its own rotation beats a dead frame.
        console.warn('[butterchurn-iframe] Eviland feedback integration unavailable; running plain MilkDrop');
        liveMode = false;
      }
    }
    if (liveMode && livePipeline) {
      // In Live the Director owns preset changes: one preset per look, chosen
      // by hash so a track's sections map to the same presets on every play.
      // Same light-half bias as the random rotation (see pickIndex).
      loadLivePreset = () => {
        if (!latestComposition || !visualizer) return;
        // Keyed on the look a fade is heading to, so the long blend starts
        // with the fade instead of at its midpoint.
        const look = latestComposition.next ?? latestComposition.config._to ?? latestComposition.config;
        const key = `${latestComposition.seed}::${look.seed ?? look.archetype}`;
        if (key === lastCompositionKey) return;
        lastCompositionKey = key;
        const hash = hashSeed(key);
        const halfBoundary = Math.max(1, Math.floor(presetOrder.length / 2));
        const fromLight = hash % 100 < 85;
        const lo = fromLight ? 0 : halfBoundary;
        const span = fromLight ? halfBoundary : Math.max(1, presetOrder.length - halfBoundary);
        const index = presetOrder[lo + ((hash >>> 8) % span)] ?? presetOrder[0]!;
        // A long blend is where MilkDrop's transitions come from: both presets
        // run while a wipe, plasma or radial pattern hands the frame over.
        if (livePresetLoader) livePresetLoader.request(presets[index]![1], key, LIVE_BLEND_SECONDS);
        else try { visualizer.loadPreset(presets[index]![1], LIVE_BLEND_SECONDS); } catch { loadRandomPreset(LIVE_BLEND_SECONDS); }
      };
      // The tier changed after init (the projector moved to another display):
      // the pipeline's passes and simulations are sized by it, so it is built
      // again. Falls back to plain MilkDrop like a failed init does.
      rebuildLivePipeline = () => {
        if (!visualizer) return;
        livePipeline?.dispose();
        livePipeline = createEvilandLivePipeline(visualizer, hostConfig.quality);
        if (livePipeline) {
          if (latestComposition) livePipeline.update(latestComposition);
        } else {
          console.warn('[butterchurn-iframe] Eviland feedback integration lost on a tier change; running plain MilkDrop');
          liveMode = false;
        }
      };
      if (latestComposition) {
        livePipeline.update(latestComposition);
        loadLivePreset();
      } else {
        loadRandomPreset(0);
      }
    } else {
      loadRandomPreset(0);
    }

    // Plain MilkDrop rotates on a timer. In Live the Director owns changes.
    const scheduleRotation = (): void => {
      if (presetTimer != null) window.clearInterval(presetTimer);
      // Skip a rotation tick when the page is hidden OR the parent stopped
      // sending audio (track paused) — compiling a preset nobody can see is
      // wasted CPU.
      presetTimer = window.setInterval(() => {
        if (liveMode && livePipeline) return;
        if (!pageVisible) return;
        if (performance.now() - lastAudioPostAt > 1500) return; // parent gone
        // Paused playback: the parent still posts (flatline) audio, so the
        // check above never fires — but compiling a preset nobody hears is a
        // 50–80MB allocation storm + GC pause every 22s. Skip while quiet.
        if (activity.idle(performance.now())) return;
        rotateToRandomPreset(2.0);
      }, 22000);
    };
    scheduleRotation();

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        pageVisible = !document.hidden;
      });
    }

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => sizeCanvas()).observe(canvas);
    }

    // Tell the parent butterchurn really mounted (mirrors the old
    // data-newamp-butterchurn-mounted='true' boot signal the UI smoke checks).
    mountedAt = performance.now();
    post({ type: 'mounted' });

    // The next animation frame is booked for when the next paint is due, and
    // again after every paint, so a paint made from a message does not leave
    // the earlier booking to wake the page for nothing.
    const bookFrame = (): void => {
      if (disposed) return;
      cancelFrame();
      cancelFrame = requestPacedFrame(frame, cadence.msUntilDue(performance.now()));
    };
    paintTick = (): boolean => {
      // Cadence cap: 45fps while audio is live, 20fps idle glide once the
      // track has been quiet for a while (paused/stopped). The governor
      // stretches the interval further at its fps-trim floor.
      const now = performance.now();
      if (!cadence.due(now)) return false;
      cadence.commit(now);
      const dtMs = lastPaintAt ? now - lastPaintAt : 1000 / 45;
      lastPaintAt = now;
      sizeCanvas();
      const renderStart = performance.now();
      try {
        livePresetLoader?.advance();
        livePipeline?.advance(dtMs);
        visualizer?.render(
          haveAudio
            ? {
                audioLevels: {
                  timeByteArray: latestTime,
                  timeByteArrayL: latestTime,
                  timeByteArrayR: latestTime,
                },
              }
            : undefined,
        );
      } catch {
        /* keep the loop alive across a transient preset/render hiccup */
      }
      // After Butterchurn's last draw (the Live grade included) and inside
      // the governed cost: the governor can trim the DPR it runs at, never
      // switch it off.
      flashGuard?.apply(dtMs);
      gov.endFrame(now, performance.now() - renderStart);
      bookFrame();
      return true;
    };
    // Sleeps between paints instead of waking on every vsync to skip most of
    // them.
    measureDisplayRefresh();
    function frame(): void {
      if (disposed) return;
      lastFrameAt = performance.now();
      if (!paintTick?.()) bookFrame();
    }
    cancelFrame = requestPacedFrame(frame, 0);
  } catch (err) {
    post({ type: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as BcParentMessage | undefined;
  if (!message || typeof message !== 'object') return;
  if (event.source !== parent) return;
  if (message.type === 'init') {
    liveMode = Boolean(message.eviland);
    hostConfig.quality = message.quality ?? 'high';
    hostConfig.dpr = message.dpr > 0 ? message.dpr : 1;
    hostConfig.maxPixels = message.maxPixels && message.maxPixels > 0 ? message.maxPixels : Infinity;
    hostConfig.sampleRate = message.sampleRate;
    void start();
  } else if (message.type === 'config') {
    const change = applyConfig(hostConfig, message);
    // A new display usually has another refresh rate too.
    if (change.dpr) measureDisplayRefresh(true);
    if (change.dpr || change.maxPixels) sizeCanvas();
    if (change.sampleRate) retuneButterchurnBands(visualizer, clampRate(hostConfig.sampleRate));
    if (change.quality && liveMode) rebuildLivePipeline?.();
  } else if (message.type === 'audio') {
    if (liveMode && message.eviland) {
      latestComposition = message.eviland;
      livePipeline?.update(latestComposition);
      loadLivePreset?.();
    }
    if (message.samples && message.samples.length) {
      latestTime.set(message.samples.subarray(0, BUTTERCHURN_FFT_SIZE));
      haveAudio = true;
      lastAudioPostAt = performance.now();
      // A paused analyser emits exactly-flat bytes (128 ±1), but so does a
      // passage quieter than the 8-bit quantisation (about -39 dBFS). The
      // parent says whether the track is playing; flat bytes only decide for
      // a parent that doesn't. The quiet dwell is what slows the cadence, so
      // a brief digital-silence gap inside a track never drops frames.
      let flat = true;
      for (let i = 0; i < BUTTERCHURN_FFT_SIZE; i += 1) {
        const b = latestTime[i]!;
        if (b < 127 || b > 129) { flat = false; break; }
      }
      activity.observe(lastAudioPostAt, flat, message.playing);
      if (paintTick && paintsFromMessage(lastAudioPostAt, lastFrameAt, lastPaintAt || mountedAt)) paintTick();
    }
  } else if (message.type === 'dispose') {
    disposed = true;
    paintTick = null;
    livePresetLoader?.dispose();
    livePresetLoader = null;
    livePipeline?.dispose();
    livePipeline = null;
    flashGuard?.dispose();
    flashGuard = null;
    cancelFrame();
    if (presetTimer != null) window.clearInterval(presetTimer);
    // This frame is about to navigate away; hand its GL context back now
    // rather than when the document is collected.
    try { canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* already gone */ }
  }
});

// Read by the detached-projector smoke when capturePage can't get a
// compositor frame: lit fraction of the last composed Live image.
Object.defineProperty(window, '__newampLiveSample', {
  configurable: true,
  value: (): number => livePipeline?.sample() ?? 0,
});

// Signal readiness so the parent posts the init payload (sampleRate, dpr).
post({ type: 'ready' });
