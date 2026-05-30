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
let pendingPresetIdle: number | null = null;
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
    const [butterchurnModule, presetModule] = await Promise.all([
      import('butterchurn'),
      import('butterchurn-presets'),
    ]);
    if (disposed) return;
    const butterchurn = unwrapDefault<{
      createVisualizer(
        context: BaseAudioContext,
        canvas: HTMLCanvasElement,
        opts: Record<string, unknown>,
      ): ButterchurnVisualizer;
    }>(butterchurnModule);
    const presetApi = unwrapDefault<{ getPresets(): Record<string, Record<string, unknown>> }>(presetModule);

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
      meshWidth: 32,
      meshHeight: 24,
    });

    presets = Object.entries(presetApi.getPresets()).filter(
      (entry): entry is [string, Record<string, unknown>] => !!entry[1] && typeof entry[1] === 'object',
    );
    if (!presets.length) throw new Error('No Butterchurn presets loaded');

    // Weight = JSON length as a cheap proxy for equation-body complexity.
    // Heavier presets take longer to JIT-compile inside loadPreset(), which is
    // the actual frame-blocking hitch users see as "lag between animations".
    presetWeights = presets.map(([, preset]) => {
      try { return JSON.stringify(preset).length; } catch { return 0; }
    });
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

    // Run the heavy loadPreset() during the iframe's idle time so the JIT
    // compile lands between paints rather than mid-frame. Falls back to
    // setTimeout(0) where requestIdleCallback isn't available.
    type IdleCb = (cb: () => void, opts?: { timeout: number }) => number;
    const ric: IdleCb = (window as unknown as { requestIdleCallback?: IdleCb }).requestIdleCallback
      ?? ((cb) => window.setTimeout(cb, 0) as unknown as number);
    const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
      ?? ((id: number) => window.clearTimeout(id));

    const loadRandomPreset = (blendSeconds: number): void => {
      if (pendingPresetIdle != null) cic(pendingPresetIdle);
      pendingPresetIdle = ric(() => {
        pendingPresetIdle = null;
        if (disposed || !visualizer) return;
        const [, preset] = presets[pickIndex()]!;
        try { visualizer.loadPreset(preset, blendSeconds); } catch { /* bad preset, skip */ }
      }, { timeout: 1500 });
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
    if (pendingPresetIdle != null) {
      const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
        ?? ((id: number) => window.clearTimeout(id));
      cic(pendingPresetIdle);
      pendingPresetIdle = null;
    }
  }
});

// Signal readiness so the parent posts the init payload (sampleRate, dpr).
post({ type: 'ready' });
