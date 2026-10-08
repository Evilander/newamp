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
import { createEvilandLivePipeline, type LiveCompositionFrame } from '../visualizer/eviland-live-pipeline';
import { createLivePresetLoader } from '../visualizer/eviland-live-presets';
import { hashSeed } from '../visualizer/eviland-rng';
import { createGovernor } from '../visualizer/eviland-governor';
import { attachFlashGuard, type AttachedFlashGuard } from '../visualizer/flash-guard-host';

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

let visualizer: ButterchurnVisualizer | null = null;
// Photosensitivity limiter on every frame this canvas shows, plain MilkDrop
// and Eviland Live alike, in the main window and the projector. It follows
// the Settings toggle through this origin's localStorage.
let flashGuard: AttachedFlashGuard | null = null;
let liveMode = false;
let liveQuality: 'high' | 'medium' | 'low' = 'high';
let livePipeline: ReturnType<typeof createEvilandLivePipeline> = null;
let livePresetLoader: ReturnType<typeof createLivePresetLoader> = null;
let latestComposition: LiveCompositionFrame | null = null;
// Seconds Butterchurn blends two presets when the Live Director changes look.
const LIVE_BLEND_SECONDS = 4.5;
let loadLivePreset: (() => void) | null = null;
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
let raf = 0;
// One paint at the governed cadence. Normally driven by rAF; the audio message
// handler calls it too when rAF has been starved (see STARVED_PAINT_MS).
let paintTick: ((now: number) => void) | null = null;
// Chromium stops rAF for an occluded window. The detached projector keeps
// receiving timer-driven audio while covered, so paint from the message at a
// slow rate: MilkDrop's feedback keeps evolving and the window is never a
// stale frame when it is uncovered again.
const STARVED_PAINT_MS = 250;
let mountedAt = 0;
let dpr = 1;
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
// idle glide when the analyser has been byte-flat for a few seconds (the
// parent keeps posting flatline bytes while paused, so "no messages" never
// fires — flatness is the real pause signal), and a measured-cost governor
// that steps the render DPR down when this machine can't hold the cadence.
let lastPaintAt = 0;
// performance.now() when byte-flat audio began; -1 while audio is live.
let silentSince = -1;
const IDLE_AFTER_MS = 3000;
const LIVE_FRAME_MS = 1000 / 45;
const IDLE_FRAME_MS = 1000 / 20;
// MilkDrop is the star of this mode — give it a bigger budget than the
// overlay layers get in the parent before trimming resolution.
const gov = createGovernor({ costBudgetMs: 10 });

function sizeCanvas(): void {
  if (!canvas) return;
  const effDpr = dpr * gov.scale();
  const w = Math.max(8, Math.floor((canvas.clientWidth || 640) * effDpr));
  const h = Math.max(8, Math.floor((canvas.clientHeight || 360) * effDpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    visualizer?.setRendererSize(w, h);
  }
}

async function start(sampleRate: number): Promise<void> {
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
    const rate = Math.max(8000, Math.min(96000, Math.round(sampleRate) || 44100));
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

    // Plain MilkDrop retains its existing load path. Live uses the same typed
    // megabuffer build patch plus the asynchronous shader loader below.
    const loadRandomPreset = (blendSeconds: number): void => {
      if (disposed || !visualizer) return;
      const [, preset] = presets[pickIndex()]!;
      try { visualizer.loadPreset(preset, blendSeconds); } catch { /* bad preset, skip */ }
    };
    if (liveMode) {
      livePipeline = createEvilandLivePipeline(visualizer, liveQuality);
      if (!livePipeline) {
        // Butterchurn's private renderer isn't shaped the way the adapter
        // expects. Plain MilkDrop with its own rotation beats a dead frame.
        console.warn('[butterchurn-iframe] Eviland feedback integration unavailable; running plain MilkDrop');
        liveMode = false;
      }
    }
    if (liveMode && livePipeline) {
      livePresetLoader = createLivePresetLoader(visualizer, () => loadRandomPreset(LIVE_BLEND_SECONDS));
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
      if (latestComposition) {
        livePipeline.update(latestComposition);
        loadLivePreset();
      } else {
        loadRandomPreset(0);
      }
    } else {
      loadRandomPreset(0);
    }

    const scheduleRotation = (): void => {
      if (presetTimer != null) window.clearInterval(presetTimer);
      // Skip a rotation tick when the page is hidden OR the parent stopped
      // sending audio (track paused) — compiling a preset nobody can see is
      // wasted CPU.
      presetTimer = window.setInterval(() => {
        if (!pageVisible) return;
        if (performance.now() - lastAudioPostAt > 1500) return; // parent gone
        // Paused playback: the parent still posts (flatline) audio, so the
        // check above never fires — but compiling a preset nobody hears is a
        // 50–80MB allocation storm + GC pause every 22s. Skip while silent.
        if (silentSince >= 0 && performance.now() - silentSince > IDLE_AFTER_MS) return;
        loadRandomPreset(2.0);
      }, 22000);
    };
    if (!liveMode) scheduleRotation();

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

    paintTick = (now: number): void => {
      // Cadence cap: 45fps while audio is live, 20fps idle glide once the
      // analyser has been byte-flat for a while (paused/stopped). The
      // governor stretches the interval further at its fps-trim floor.
      const idle = silentSince >= 0 && now - silentSince > IDLE_AFTER_MS;
      if (now - lastPaintAt < gov.intervalMs(idle ? IDLE_FRAME_MS : LIVE_FRAME_MS)) return;
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
    };
    const frame = (now: number): void => {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      paintTick?.(now);
    };
    raf = requestAnimationFrame(frame);
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
    liveQuality = message.quality ?? 'high';
    dpr = message.dpr > 0 ? message.dpr : 1;
    void start(message.sampleRate);
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
      // Pause detection: a paused/stopped analyser emits exactly-flat bytes
      // (128 ±1). Real music — even a whisper-quiet passage — wobbles more.
      // Track when flatness began; frame() idles the cadence after a dwell,
      // so a brief digital-silence gap inside a track never drops frames.
      let flat = true;
      for (let i = 0; i < BUTTERCHURN_FFT_SIZE; i += 1) {
        const b = latestTime[i]!;
        if (b < 127 || b > 129) { flat = false; break; }
      }
      silentSince = flat ? (silentSince >= 0 ? silentSince : lastAudioPostAt) : -1;
      if (paintTick && lastAudioPostAt - (lastPaintAt || mountedAt) > STARVED_PAINT_MS) paintTick(lastAudioPostAt);
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
    cancelAnimationFrame(raf);
    if (presetTimer != null) window.clearInterval(presetTimer);
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
