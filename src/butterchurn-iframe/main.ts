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
let presetTimer: number | null = null;
let raf = 0;
let dpr = 1;
let disposed = false;
let started = false;
let haveAudio = false;
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

    const loadRandomPreset = (blendSeconds: number): void => {
      const [, preset] = presets[Math.floor(Math.random() * presets.length)]!;
      visualizer?.loadPreset(preset, blendSeconds);
    };
    loadRandomPreset(0);
    presetTimer = window.setInterval(() => loadRandomPreset(2.2), 22000);

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
    }
  } else if (message.type === 'dispose') {
    disposed = true;
    cancelAnimationFrame(raf);
    if (presetTimer != null) window.clearInterval(presetTimer);
  }
});

// Signal readiness so the parent posts the init payload (sampleRate, dpr).
post({ type: 'ready' });
