// Browser-side probe bundled by scripts/scene-overlay-smoke.mjs (esbuild).
// Compiles + renders EVERY registered scene against synthetic frames and
// reports per-scene: compiled, lit pixel fraction (energetic), reactivity
// (energetic vs silent pixel delta), and motion (two energetic frames apart
// in time differ). The smoke asserts on these — a scene that is black, inert,
// or audio-deaf fails the gate.

import { createSceneOverlay } from '../src/visualizer/scene-overlay';
import { SCENES } from '../src/visualizer/scenes/index';
import type { EvilandFrame } from '../src/visualizer/eviland-audio';
import type { EvilandPalette } from '../src/visualizer/eviland';

const W = 320;
const H = 180;

function makeFrame(energetic: boolean, t: number): EvilandFrame {
  const bands = new Float32Array(24);
  if (energetic) {
    for (let i = 0; i < 24; i++) {
      bands[i] = 0.35 + 0.5 * Math.abs(Math.sin(i * 0.7 + t * 2.1));
    }
  }
  return {
    bands,
    onsets: energetic
      ? [
          { band: 1, group: 'kick', intensity: 0.9, sharpness: 0.8 },
          { band: 8, group: 'snare', intensity: 0.7, sharpness: 0.6 },
          { band: 21, group: 'hat', intensity: 0.6, sharpness: 0.9 },
          { band: 12, group: 'vocal', intensity: 0.5, sharpness: 0.4 },
        ]
      : [],
    kick: energetic ? 0.85 : 0,
    bass: energetic ? 0.7 : 0,
    snare: energetic ? 0.6 : 0,
    hat: energetic ? 0.5 : 0,
    vocal: energetic ? 0.55 : 0,
    energy: energetic ? 0.72 : 0,
    centroid: energetic ? 0.55 : 0,
    flatness: energetic ? 0.4 : 0,
    crest: energetic ? 0.6 : 0,
    rolloff: energetic ? 0.5 : 0,
    width: energetic ? 0.5 : 0,
    pan: energetic ? 0.15 : 0,
    beatPhase: (t * 2) % 1,
    beatConfidence: energetic ? 0.8 : 0,
    bpm: 120,
    novelty: 0,
    sectionId: 1,
    sectionChanged: false,
    sectionReturn: -1,
    sectionFingerprint: null,
  };
}

const PALETTE: EvilandPalette = {
  accent: [0.22, 1.0, 0.35],
  dark: [0.05, 0.3, 0.12],
  light: [0.9, 1.0, 0.92],
  bg: [0.02, 0.02, 0.04],
};

interface SceneResult {
  id: string;
  compiled: boolean;
  litFraction: number;
  reactivity: number;
  motion: number;
  error?: string;
}

function readPixels(gl: WebGL2RenderingContext): Uint8Array {
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return buf;
}

function litFraction(px: Uint8Array): number {
  let lit = 0;
  let total = 0;
  for (let i = 0; i < px.length; i += 16) {
    const lum = (px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0);
    if (lum > 24) lit += 1;
    total += 1;
  }
  return total ? lit / total : 0;
}

function meanDelta(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 16) {
    sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0)) + Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) + Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0));
    n += 3;
  }
  return n ? sum / n : 0;
}

async function probe(): Promise<{ webgl2: boolean; scenes: SceneResult[] }> {
  const results: SceneResult[] = [];

  for (const def of SCENES) {
    // Fresh canvas + overlay per scene: isolates GL state and makes a compile
    // failure in one scene unable to poison the next.
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const overlay = createSceneOverlay(canvas, { quality: 'high', seedKey: 'scene-smoke' });
    if (!overlay) {
      return { webgl2: false, scenes: results };
    }
    const gl = canvas.getContext('webgl2')!;
    overlay.resize(W, H, 1);
    overlay.setScene(def.id);

    const result: SceneResult = { id: def.id, compiled: false, litFraction: 0, reactivity: 0, motion: 0 };
    try {
      // Warm up: several energetic frames so time-driven scenes develop.
      for (let i = 0; i < 8; i++) overlay.render(makeFrame(true, i * 0.13), PALETTE, 33);
      const litA = readPixels(gl);
      // Advance time for motion check.
      for (let i = 8; i < 16; i++) overlay.render(makeFrame(true, i * 0.13), PALETTE, 33);
      const litB = readPixels(gl);
      // Silence — onset pulses decay over ~10 frames of render calls.
      for (let i = 0; i < 30; i++) overlay.render(makeFrame(false, (16 + i) * 0.13), PALETTE, 33);
      const quiet = readPixels(gl);

      // A blacklisted (failed-compile) scene reports its id as something else
      // because the rotation moved on.
      result.compiled = overlay.currentSceneId() === def.id;
      result.litFraction = litFraction(litA);
      result.motion = meanDelta(litA, litB);
      result.reactivity = meanDelta(litA, quiet);
    } catch (err) {
      result.error = String((err as Error)?.message ?? err);
    } finally {
      overlay.dispose();
    }
    results.push(result);
  }
  return { webgl2: true, scenes: results };
}

(window as unknown as { __sceneProbe: () => Promise<unknown> }).__sceneProbe = probe;
