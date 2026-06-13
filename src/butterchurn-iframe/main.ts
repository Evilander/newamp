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

// Estimate the main-thread cost of switching TO a preset. The dominant cost is
// butterchurn allocating an ~8 MB megabuffer per ENABLED shape and wave inside
// loadPreset() (plus running their init equations + compiling their shaders) —
// a 50–80 MB allocation storm and a major GC pause that reads as a stutter.
// Equation-body length is a minor secondary factor. Bias rotation toward cheap
// presets and the inter-animation hitch largely disappears.
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
  let cost = (shapes + waves) * 100_000; // each ≈ one 8 MB megabuf alloc
  try { cost += JSON.stringify(preset).length; } catch { /* circular — ignore */ }
  return cost;
}

let visualizer: ButterchurnVisualizer | null = null;
let presets: Array<[string, Record<string, unknown>]> = [];
// Lightweight presets only — the heaviest entries in the full preset pack are
// the ones with sprawling per_pixel / per_frame equation bodies that JIT-compile
// slowly inside loadPreset(), which is what users perceive as "lag between
// animations". Sorted-by-weight ascending; rotation picks from the lighter
// portion most of the time with an occasional excursion into a heavier one.
let presetWeights: number[] = [];
let presetOrder: number[] = [];
let lastAudioPostAt = 0;
let presetTimer: number | null = null;
// When >0, frame() holds the last painted frame for this many ticks. Used to
// give butterchurn's synchronous loadPreset() shader-compile + megabuf GC a
// clear slot instead of colliding with an active paint (the inter-preset judder).
let skipRenderFrames = 0;
let raf = 0;
let dpr = 1;
let disposed = false;
let started = false;
let haveAudio = false;
let pageVisible = typeof document === 'undefined' ? true : !document.hidden;
const latestTime = new Uint8Array(BUTTERCHURN_FFT_SIZE);

function sizeCanvas(): void {
  if (!canvas) return;
  const w = Math.max(8, Math.floor((canvas.clientWidth || 640) * dpr));
  const h = Math.max(8, Math.floor((canvas.clientHeight || 360) * dpr));
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

    presets = Object.entries(presetCatalog).filter(
      (entry): entry is [string, Record<string, unknown>] => !!entry[1] && typeof entry[1] === 'object',
    );
    if (!presets.length) throw new Error('No Butterchurn presets loaded');

    // The real cost of a preset switch is NOT equation-body length — it's the
    // ~8 MB `new Array(1048576).fill(0)` megabuffer butterchurn allocates per
    // ENABLED shape and wave inside loadPreset (a 50–80 MB allocation storm +
    // major GC pause). So weight primarily by enabled shape/wave count; JSON
    // length is only a minor tiebreaker for equation JIT cost.
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

    // loadPreset() does its heavy work (GLSL compile + ~8 MB/shape megabuf
    // allocation) SYNCHRONOUSLY on this thread. requestIdleCallback was tried
    // here but is a no-op: the continuous rAF render loop below never yields a
    // real idle window, so ric just falls through to its setTimeout(0) deadline
    // and the compile still lands on a paint frame. Instead we hold the next
    // paint (skipRenderFrames) so the compile + first heavy render + GC get a
    // clear frame, then the loop resumes smoothly.
    const loadRandomPreset = (blendSeconds: number): void => {
      if (disposed || !visualizer) return;
      const [, preset] = presets[pickIndex()]!;
      skipRenderFrames = 1;
      try { visualizer.loadPreset(preset, blendSeconds); } catch { /* bad preset, skip */ }
    };
    loadRandomPreset(0);

    const scheduleRotation = (): void => {
      if (presetTimer != null) window.clearInterval(presetTimer);
      // Skip a rotation tick when the page is hidden OR the parent stopped
      // sending audio (track paused) — compiling a preset nobody can see is
      // wasted CPU.
      presetTimer = window.setInterval(() => {
        if (!pageVisible) return;
        if (performance.now() - lastAudioPostAt > 1500) return; // parent paused
        loadRandomPreset(2.0);
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
    post({ type: 'mounted' });

    const frame = (): void => {
      if (disposed) return;
      sizeCanvas();
      if (skipRenderFrames > 0) {
        // Hold the last painted frame one tick so a just-loaded preset's compile
        // + GC settle off the critical paint path.
        skipRenderFrames -= 1;
        raf = requestAnimationFrame(frame);
        return;
      }
      try {
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
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  } catch (err) {
    post({ type: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as BcParentMessage | undefined;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'init') {
    dpr = message.dpr > 0 ? message.dpr : 1;
    void start(message.sampleRate);
  } else if (message.type === 'audio') {
    if (message.samples && message.samples.length) {
      latestTime.set(message.samples.subarray(0, BUTTERCHURN_FFT_SIZE));
      haveAudio = true;
      lastAudioPostAt = performance.now();
    }
  } else if (message.type === 'dispose') {
    disposed = true;
    cancelAnimationFrame(raf);
    if (presetTimer != null) window.clearInterval(presetTimer);
  }
});

// Signal readiness so the parent posts the init payload (sampleRate, dpr).
post({ type: 'ready' });
