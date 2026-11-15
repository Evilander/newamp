// Eviland Live layer compositor — one canvas carrying what the user actually
// sees (MilkDrop field + scene overlay + reactor events), for anything that
// needs to capture the composition: press-to-record, the retroactive replay
// ring, Wrapped Live.
//
// WebGL layers are pulled through captureStream()→<video>, NOT drawImage —
// drawImage against a WebGL canvas whose buffer was already composited can
// read transparent black (preserveDrawingBuffer is off everywhere here);
// captureStream taps the composited output and is reliable. The 2D reactor
// canvas draws directly. The paint loop runs on rAF, which is correct for
// every consumer: the composition only exists while the fullscreen stage is
// visible.

export interface LiveCompositor {
  canvas: HTMLCanvasElement;
  stop(): void;
  /**
   * True once what this compositor was built from no longer matches the
   * stage: the field canvas changed size, was replaced (an iframe reload), or
   * its stream ended. The output keeps its original size and shows a frozen
   * layer until then, so a caller that can start over (the replay ring, which
   * is not mid-clip) should re-arm on this. A recording in progress stays at
   * its fixed size on purpose: resizing a canvas under an encoder breaks the clip.
   */
  stale(): boolean;
}

// How often the paint loop compares the field with what it was built from.
const STALE_CHECK_EVERY_FRAMES = 30;

/**
 * Find the eviland-live layer stack under `root` and start compositing it
 * into a fresh offscreen canvas. Null when the stage isn't ready (no field
 * canvas yet) — callers surface their own message.
 */
export function createEvilandLiveCompositor(root: HTMLElement): LiveCompositor | null {
  const iframe = root.querySelector('iframe') as HTMLIFrameElement | null;
  const bcCanvas = (iframe?.style.display !== 'none' ? iframe?.contentDocument : null)?.getElementById('bc') as HTMLCanvasElement | null;
  const baseCanvas = root.querySelector('canvas[data-newamp-visualizer-canvas]') as HTMLCanvasElement | null;
  const sceneCanvas = root.querySelector('canvas[data-newamp-scene-overlay]') as HTMLCanvasElement | null;
  const reactorCanvas = root.querySelector('canvas[data-newamp-reactor-overlay]') as HTMLCanvasElement | null;
  const field = bcCanvas ?? baseCanvas; // 2D fallback painter when MilkDrop failed
  if (!field || typeof field.captureStream !== 'function') return null;

  const w = Math.max(2, field.width);
  const h = Math.max(2, field.height);
  const compositor = document.createElement('canvas');
  compositor.width = w;
  compositor.height = h;
  const ctx = compositor.getContext('2d');
  if (!ctx) return null;

  const cleanups: Array<() => void> = [];
  const layerVideo = (source: HTMLCanvasElement): HTMLVideoElement | null => {
    try {
      const stream = source.captureStream(60);
      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      void video.play().catch(() => undefined);
      cleanups.push(() => {
        try {
          video.pause();
          video.srcObject = null;
          for (const track of stream.getTracks()) track.stop();
        } catch {
          /* teardown best-effort */
        }
      });
      return video;
    } catch {
      return null;
    }
  };

  const fieldVideo = layerVideo(field);
  const sceneVideo = sceneCanvas ? layerVideo(sceneCanvas) : null;
  let fieldEnded = false;
  const fieldTrack = (fieldVideo?.srcObject as MediaStream | null)?.getVideoTracks()[0];
  fieldTrack?.addEventListener('ended', () => { fieldEnded = true; });
  if (!fieldVideo) {
    for (const fn of cleanups) fn();
    return null;
  }

  let running = true;
  let frames = 0;
  let isStale = false;
  let wasHidden = false;
  const drawLayer = (video: HTMLVideoElement | null): void => {
    if (video && video.readyState >= 2) {
      try {
        ctx.drawImage(video, 0, 0, w, h);
      } catch {
        /* layer mid-resize — skip this frame */
      }
    }
  };
  const paint = (): void => {
    if (!running) return;
    // rAF is already throttled by Chromium while the window is hidden, but
    // skip the composite work outright rather than rely on that alone —
    // callers (the recording path in particular) keep this loop running for
    // the full duration regardless of visibility. Reschedule instead of
    // returning early so the loop resumes drawing the moment it's visible
    // again, without any caller having to re-arm it.
    if (++frames % STALE_CHECK_EVERY_FRAMES === 0 && !isStale) {
      isStale = fieldEnded || !field.isConnected || field.width !== w || field.height !== h;
    }
    // Both layers are 60 fps streams: stop decoding them while the window is
    // hidden and pick them up again when it is back.
    if (document.hidden !== wasHidden) {
      wasHidden = document.hidden;
      for (const video of [fieldVideo, sceneVideo]) {
        if (!video) continue;
        if (wasHidden) video.pause();
        else void video.play().catch(() => undefined);
      }
    }
    if (!document.hidden) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      drawLayer(fieldVideo);
      drawLayer(sceneVideo);
      if (reactorCanvas) {
        try {
          ctx.drawImage(reactorCanvas, 0, 0, w, h);
        } catch {
          /* 2D layer mid-resize */
        }
      }
    }
    requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);

  return {
    canvas: compositor,
    stop() {
      running = false;
      for (const fn of cleanups) fn();
    },
    stale: () => isStale,
  };
}
