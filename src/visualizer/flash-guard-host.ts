// Host glue for the flash guard: every visualizer output route attaches one
// of these to its final surface.
//
//   attachFlashGuard      a WebGL2 renderer's context: apply() after its last
//                         draw of the frame (Eviland, particle flow, the
//                         shader modes, MilkDrop and Eviland Live in the
//                         iframe, the projector's fallback renderer)
//   createGuarded2dSurface  the Canvas 2D painters: paint offscreen and
//                         present through the GPU guard on the visible canvas,
//                         or paint in place and use the CPU guard
//   guardCanvas2d         a 2D fallback painter with no GPU behind it
//
// Each follows the Settings toggle live and forgets its history when
// protection comes back on. Nothing here depends on requestAnimationFrame:
// callers apply the guard from whatever loop draws the frame, including the
// projector's message-driven paints while its window is occluded.

import { flashGuardEnabled, watchFlashGuard } from '../lib/vizPrefs';
import { HAZARD_AREA } from './flash-guard';
import { createCanvasFlashGuard } from './flash-guard-2d';
import { createFlashGuardGL, screenFractionOf } from './flash-guard-gl';

export interface FlashSetting {
  readonly on: boolean;
  stop(): void;
}

/** The current setting as a field a render loop can read every frame. */
export function followFlashGuard(onEnable?: () => void): FlashSetting {
  let on = flashGuardEnabled();
  const stop = watchFlashGuard((next) => {
    if (next && !on) onEnable?.();
    on = next;
  });
  return {
    get on() {
      return on;
    },
    stop,
  };
}

let gpuSupported = false;
let gpuFailedAt = -Infinity;
/** How long a failed probe stands before the next caller tries again. */
const GPU_RETRY_MS = 5000;

/**
 * Whether the GPU guard can run here, found by building one on a throwaway
 * canvas: getContext binds a canvas to one context type for good, so a GPU
 * route that bound the real canvas and then couldn't attach its guard would
 * leave nothing for the guarded 2D painters to draw on. Every GPU route asks
 * this before it creates its context. Building the whole guard (programs
 * linked, float targets complete) rather than checking the extension keeps a
 * driver that advertises float targets but can't render the guard's passes
 * on the 2D painters. A success holds for the document; a failure (which can
 * be transient: a GPU process restarting, contexts briefly exhausted) is
 * tried again by the next route to mount after GPU_RETRY_MS.
 */
export function gpuFlashGuardSupported(): boolean {
  if (gpuSupported) return true;
  if (typeof document === 'undefined') return false;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - gpuFailedAt < GPU_RETRY_MS) return false;
  const probe = document.createElement('canvas').getContext('webgl2');
  const guard = probe ? createFlashGuardGL(probe) : null;
  gpuSupported = !!guard;
  if (!guard) gpuFailedAt = now;
  guard?.dispose();
  probe?.getExtension('WEBGL_lose_context')?.loseContext();
  return gpuSupported;
}

export interface AttachedFlashGuard {
  /** After the renderer's last draw of the frame. */
  apply(dtMs: number): void;
  dispose(): void;
}

/**
 * Guard a WebGL2 renderer's output in place. `surface` is the element the
 * viewer sees (its share of the screen sizes the guard's blocks). Null when
 * this context can't host the guard; callers then fall back to a guarded
 * route.
 */
export function attachFlashGuard(gl: WebGL2RenderingContext | null, surface: HTMLElement): AttachedFlashGuard | null {
  const guard = gl ? createFlashGuardGL(gl) : null;
  if (!guard) return null;
  const setting = followFlashGuard(() => guard.reset());
  return {
    apply(dtMs) {
      guard.apply(dtMs, setting.on ? screenFractionOf(surface) : 0);
    },
    dispose() {
      setting.stop();
      guard.dispose();
    },
  };
}

export interface Guarded2dSurface {
  /** Where the painter draws: offscreen when presenting through the GPU guard. */
  readonly paint: HTMLCanvasElement;
  /** Show what was painted this frame. */
  show(dtMs: number): void;
  dispose(): void;
}

// Once a canvas is bound to WebGL2 it can never give a 2D context, so the
// presenter decision is made once per element and kept.
const presents = new WeakMap<HTMLCanvasElement, boolean>();

/**
 * A Canvas 2D painter's output surface. `mayMatter` says whether the canvas
 * can ever cover HAZARD_AREA of the screen (a fullscreen stage can, a 120x36
 * transport meter can't); small surfaces paint in place and skip the guard.
 */
export function createGuarded2dSurface(visible: HTMLCanvasElement, mayMatter: boolean, smoke = false): Guarded2dSurface {
  let decided = presents.get(visible);
  if (decided == null) {
    decided = mayMatter && gpuFlashGuardSupported();
    presents.set(visible, decided);
  }
  const gl = decided
    ? visible.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: smoke })
    : null;
  const gpu = gl ? createFlashGuardGL(gl) : null;
  const offscreen = gpu ? document.createElement('canvas') : null;
  const cpu = gpu ? null : createCanvasFlashGuard();
  const setting = followFlashGuard(() => {
    gpu?.reset();
    cpu?.reset();
  });
  const paint = offscreen ?? visible;
  return {
    paint,
    show(dtMs) {
      const fraction = setting.on ? screenFractionOf(visible) : 0;
      if (gpu && offscreen) gpu.present(offscreen, dtMs, fraction);
      else if (fraction >= HAZARD_AREA) cpu?.apply(visible, dtMs, fraction);
    },
    dispose() {
      setting.stop();
      gpu?.dispose();
    },
  };
}

/** Guard a 2D canvas painted in place (the fallback painters). */
export function guardCanvas2d(canvas: HTMLCanvasElement): AttachedFlashGuard {
  const guard = createCanvasFlashGuard();
  const setting = followFlashGuard(() => guard?.reset());
  return {
    apply(dtMs) {
      const fraction = setting.on ? screenFractionOf(canvas) : 0;
      if (fraction >= HAZARD_AREA) guard?.apply(canvas, dtMs, fraction);
    },
    dispose() {
      setting.stop();
    },
  };
}
