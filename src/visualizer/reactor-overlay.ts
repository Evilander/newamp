// Reactor overlay — the "build on our architecture" half of Eviland Live.
//
// butterchurn (real MilkDrop) renders the warp/zoom/decay FIELD underneath in
// its sandboxed iframe. This draws ONLY NewAmp's causal per-instrument events on
// a transparent 2D canvas stacked on top, so the MilkDrop field shows through.
//
// It deliberately reuses the same EvilandFrame the WebGL Eviland engine consumes
// (per-band onsets grouped into kick/bass/snare/hat/vocal + voice envelopes), so
// the unique "each instrument fires its own visual" behaviour rides on top of
// MilkDrop instead of replacing it. Additive compositing (globalCompositeOperation
// 'lighter') keeps it glowing and lets dark areas of the field through untouched.

import type { EvilandFrame, EvilandOnset, VoiceGroup } from './eviland-audio';
import type { EvilandPalette } from './eviland';

export interface ReactorOverlay {
  resize(cssW: number, cssH: number, dpr: number): void;
  render(frame: EvilandFrame, palette: EvilandPalette, dtMs: number): void;
  dispose(): void;
}

type EventKind = 'ring' | 'spike' | 'sparkle' | 'blob';

interface OverlayEvent {
  kind: EventKind;
  x: number; // 0..1 (left..right)
  y: number; // 0..1 (top..bottom)
  age: number; // ms
  life: number; // ms total
  intensity: number; // 0..1
  size: number; // base radius fraction of min(w,h)
  rot: number; // radians (spikes)
  r: number; // 0..255
  g: number;
  b: number;
}

const MAX_EVENTS = 72;

const KIND_FOR_GROUP: Record<VoiceGroup, EventKind | null> = {
  kick: 'ring',
  snare: 'spike',
  hat: 'sparkle',
  vocal: 'blob',
  bass: null, // bass is the continuous terrain glow, not a discrete event
  other: 'sparkle',
};

// Per-group color bias applied on top of the palette so instruments stay
// distinguishable even when the palette is monochrome.
function colorForGroup(group: VoiceGroup, pal: EvilandPalette): [number, number, number] {
  const accent = pal.accent;
  const light = pal.light;
  const mix = (a: number, b: number, t: number): number => Math.round((a + (b - a) * t) * 255);
  switch (group) {
    case 'kick':
      // warm/bright floor shockwave
      return [mix(accent[0], light[0], 0.5), mix(accent[1], light[1], 0.35), mix(accent[2], light[2], 0.2)];
    case 'snare':
      return [mix(accent[0], light[0], 0.7), mix(accent[1], light[1], 0.7), mix(accent[2], light[2], 0.8)];
    case 'hat':
      // near-white sparkle
      return [mix(light[0], light[0], 1), mix(light[1], light[1], 1), Math.round(Math.min(1, light[2] + 0.1) * 255)];
    case 'vocal':
      return [Math.round(accent[0] * 255), Math.round(accent[1] * 255), Math.round(accent[2] * 255)];
    default:
      return [Math.round(light[0] * 255), Math.round(light[1] * 255), Math.round(light[2] * 255)];
  }
}

// Vertical placement: low bands sit near the floor, high bands near the top —
// "freq → vertical" from the Eviland design. band is 0..23.
function yForBand(band: number): number {
  const t = Math.min(1, Math.max(0, band / 23));
  return 0.9 - t * 0.78; // band 0 → 0.9 (low/floor), band 23 → 0.12 (top)
}

export function createReactorOverlay(canvas: HTMLCanvasElement): ReactorOverlay | null {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;

  let w = canvas.clientWidth || 640;
  let h = canvas.clientHeight || 360;
  let dpr = 1;
  let seed = 0x9e3779b9 >>> 0;
  const rand = (): number => {
    // deterministic-ish LCG so per-event jitter is cheap and varied
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  const events: OverlayEvent[] = [];
  let bassGlow = 0;

  function resize(cssW: number, cssH: number, nextDpr: number): void {
    w = Math.max(2, cssW);
    h = Math.max(2, cssH);
    dpr = Math.max(0.5, nextDpr);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn(onset: EvilandOnset, frame: EvilandFrame): void {
    const kind = KIND_FOR_GROUP[onset.group];
    if (!kind) return;
    if (events.length >= MAX_EVENTS) events.shift();
    const [r, g, b] = colorForGroup(onset.group, lastPalette);
    // Horizontal: overall stereo pan biases placement; jitter per event so
    // repeated hits of the same band don't stack on one point.
    const panX = 0.5 + frame.pan * 0.32;
    const x = Math.min(0.97, Math.max(0.03, panX + (rand() - 0.5) * 0.5));
    const y = Math.min(0.96, Math.max(0.05, yForBand(onset.band) + (rand() - 0.5) * 0.08));
    events.push({
      kind,
      x,
      y,
      age: 0,
      life: kind === 'ring' ? 620 : kind === 'blob' ? 520 : kind === 'spike' ? 360 : 280,
      intensity: Math.min(1, 0.45 + onset.intensity * 0.55),
      size: kind === 'ring' ? 0.05 + onset.intensity * 0.06 : kind === 'blob' ? 0.06 + onset.intensity * 0.05 : 0.03 + onset.sharpness * 0.04,
      rot: rand() * Math.PI,
      r,
      g,
      b,
    });
  }

  let lastPalette: EvilandPalette = {
    accent: [0.22, 1, 0.08],
    dark: [0.05, 0.2, 0.04],
    light: [0.8, 1, 0.8],
    bg: [0.02, 0.03, 0.02],
  };

  function drawEvent(ev: OverlayEvent): void {
    const c = ctx!;
    const t = ev.age / ev.life; // 0..1
    if (t >= 1) return;
    const minDim = Math.min(w, h);
    const cx = ev.x * w;
    const cy = ev.y * h;
    const fade = (1 - t) * (1 - t); // ease-out alpha
    const a = fade * ev.intensity;
    const rgb = `${ev.r}, ${ev.g}, ${ev.b}`;

    if (ev.kind === 'ring') {
      // Expanding shockwave ring (kick) — grows with age, thins as it fades.
      const radius = (ev.size + t * 0.30) * minDim;
      c.beginPath();
      c.arc(cx, cy, radius, 0, Math.PI * 2);
      c.lineWidth = Math.max(1, (1 - t) * 0.018 * minDim);
      c.strokeStyle = `rgba(${rgb}, ${a * 0.85})`;
      c.stroke();
    } else if (ev.kind === 'blob') {
      // Soft radial blob (vocal) — gentle breathing presence.
      const radius = (ev.size + t * 0.04) * minDim;
      const grad = c.createRadialGradient(cx, cy, 0, cx, cy, radius);
      grad.addColorStop(0, `rgba(${rgb}, ${a * 0.8})`);
      grad.addColorStop(1, `rgba(${rgb}, 0)`);
      c.fillStyle = grad;
      c.beginPath();
      c.arc(cx, cy, radius, 0, Math.PI * 2);
      c.fill();
    } else if (ev.kind === 'spike') {
      // Spike-star burst (snare) — radiating lines, short-lived.
      const len = (ev.size + t * 0.10) * minDim * 2;
      const spikes = 6;
      c.lineWidth = Math.max(1, (1 - t) * 0.01 * minDim);
      c.strokeStyle = `rgba(${rgb}, ${a})`;
      for (let i = 0; i < spikes; i++) {
        const ang = ev.rot + (i / spikes) * Math.PI * 2;
        c.beginPath();
        c.moveTo(cx, cy);
        c.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
        c.stroke();
      }
    } else {
      // Sparkle (hat) — small bright plus/dot.
      const s = (ev.size + t * 0.01) * minDim;
      c.strokeStyle = `rgba(${rgb}, ${a})`;
      c.lineWidth = Math.max(1, 0.004 * minDim);
      c.beginPath();
      c.moveTo(cx - s, cy);
      c.lineTo(cx + s, cy);
      c.moveTo(cx, cy - s);
      c.lineTo(cx, cy + s);
      c.stroke();
    }
  }

  function render(frame: EvilandFrame, palette: EvilandPalette, dtMs: number): void {
    lastPalette = palette;
    const c = ctx!;
    c.clearRect(0, 0, w, h); // transparent — MilkDrop field shows through
    c.globalCompositeOperation = 'lighter'; // additive glow

    // Continuous bass terrain glow along the floor (the "bass = terrain" voice),
    // smoothed so it swells rather than flickers.
    bassGlow += (frame.bass - bassGlow) * Math.min(1, dtMs / 90);
    if (bassGlow > 0.02) {
      const bh = h * (0.10 + bassGlow * 0.22);
      const [br, bg, bb] = colorForGroup('kick', palette);
      const grad = c.createLinearGradient(0, h, 0, h - bh);
      grad.addColorStop(0, `rgba(${br}, ${bg}, ${bb}, ${Math.min(0.5, bassGlow * 0.5)})`);
      grad.addColorStop(1, `rgba(${br}, ${bg}, ${bb}, 0)`);
      c.fillStyle = grad;
      c.fillRect(0, h - bh, w, bh);
    }

    // Spawn this frame's onsets, then advance + draw the live pool.
    for (const onset of frame.onsets) spawn(onset, frame);
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      ev.age += dtMs;
      if (ev.age >= ev.life) {
        events.splice(i, 1);
        continue;
      }
      drawEvent(ev);
    }

    c.globalCompositeOperation = 'source-over';
  }

  function dispose(): void {
    events.length = 0;
    ctx!.clearRect(0, 0, w, h);
  }

  return { resize, render, dispose };
}
