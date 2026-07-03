// Replay ring probe — runs inside the smoke's Electron window.
//
// Draws a bright animated pattern (motion + color so encoded frames can never
// be legitimately black), arms the real createReplayRing against it for
// longer than the configured window (so keyframe-aligned eviction actually
// exercises), saves a clip, and hands the WebM back as base64 for the node
// side to finish to MP4 and inspect with ffmpeg.

import { createReplayRing } from '../src/visualizer/eviland-replay';

declare global {
  interface Window {
    __replayProbe: () => Promise<{
      supported: boolean;
      stats?: unknown;
      blobSize?: number;
      base64?: string;
    }>;
  }
}

window.__replayProbe = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  let t = 0;
  const draw = (): void => {
    t += 1;
    const g = ctx.createLinearGradient(0, 0, 640, 360);
    g.addColorStop(0, `hsl(${(t * 3) % 360}, 90%, 55%)`);
    g.addColorStop(1, `hsl(${(t * 3 + 120) % 360}, 90%, 45%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(320 + Math.sin(t / 10) * 200, 180 + Math.cos(t / 13) * 90, 60, 0, Math.PI * 2);
    ctx.fill();
  };
  // setInterval, not rAF: the smoke window may be unfocused/occluded and this
  // probe must keep painting regardless (the real app arms only while the
  // fullscreen stage is visible, where rAF is the right clock).
  window.setInterval(draw, 33);

  const ring = createReplayRing(canvas, {
    windowMs: 4_000,
    fps: 30,
    keyframeIntervalMs: 1_000,
    videoBitsPerSecond: 2_000_000,
  });
  if (!ring) return { supported: false };
  ring.arm();
  // Run past the window so eviction happens, then save.
  await new Promise((resolve) => setTimeout(resolve, 6_500));
  const stats = ring.stats();
  const blob = await ring.saveClip();
  ring.disarm();
  if (!blob || !blob.size) return { supported: true, stats, blobSize: 0 };

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return { supported: true, stats, blobSize: blob.size, base64: btoa(binary) };
};
