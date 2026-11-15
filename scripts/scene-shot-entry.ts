// Browser-side half of scripts/scene-shot.mjs (bundled with esbuild). Renders
// the asked-for scenes over black at a few audio states and palettes and hands
// back each frame as a PNG data URL, so a scene can be looked at while it is
// being written.

import { createSceneOverlay } from '../src/visualizer/scene-overlay';
import { SCENES } from '../src/visualizer/scenes/index';
import type { EvilandFrame } from '../src/visualizer/eviland-audio';
import type { EvilandPalette } from '../src/visualizer/eviland';

const W = 640;
const H = 360;

type Level = 'silence' | 'calm' | 'loud';

function makeFrame(level: Level, t: number): EvilandFrame {
  const gain = level === 'silence' ? 0 : level === 'calm' ? 0.35 : 1;
  const bands = new Float32Array(24);
  for (let i = 0; i < 24; i++) bands[i] = gain * (0.35 + 0.5 * Math.abs(Math.sin(i * 0.7 + t * 2.1)));
  const kickNow = level === 'loud' && Math.floor(t * 2) !== Math.floor((t - 0.033) * 2);
  return {
    bands,
    onsets: kickNow
      ? [
          { band: 1, group: 'kick', intensity: 0.9, sharpness: 0.8 },
          { band: 21, group: 'hat', intensity: 0.6, sharpness: 0.9 },
        ]
      : [],
    kick: 0.85 * gain,
    bass: 0.7 * gain,
    snare: 0.6 * gain,
    hat: 0.5 * gain,
    vocal: 0.55 * gain,
    energy: 0.72 * gain,
    centroid: 0.55 * gain,
    flatness: 0.4 * gain,
    noisiness: 0.3 * gain,
    crest: 0.6 * gain,
    rolloff: 0.5 * gain,
    width: 0.5 * gain,
    pan: 0.15 * gain,
    beatPhase: (t * 2) % 1,
    beatConfidence: 0.8 * gain,
    bpm: 120,
    novelty: 0,
    sectionId: 1,
    sectionChanged: false,
    sectionReturn: -1,
    sectionFingerprint: null,
  };
}

const PALETTES: Record<string, EvilandPalette> = {
  green: { accent: [0.22, 1.0, 0.35], dark: [0.05, 0.3, 0.12], light: [0.9, 1.0, 0.92], bg: [0.02, 0.02, 0.04] },
  sunset: { accent: [1.0, 0.45, 0.2], dark: [0.35, 0.05, 0.25], light: [1.0, 0.9, 0.7], bg: [0.03, 0.01, 0.03], accent2: [0.95, 0.25, 0.55] },
  triadic: { accent: [0.95, 0.6, 0.15], dark: [0.1, 0.2, 0.55], light: [0.85, 0.95, 1.0], bg: [0.01, 0.02, 0.04], accent2: [0.2, 0.75, 0.9] },
};

function toPng(gl: WebGL2RenderingContext): string {
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d')!;
  const image = ctx.createImageData(W, H);
  // GL rows run bottom-up; composite over black, as the scene would sit on an empty field.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const src = ((H - 1 - y) * W + x) * 4;
      const dst = (y * W + x) * 4;
      image.data[dst] = px[src]!;
      image.data[dst + 1] = px[src + 1]!;
      image.data[dst + 2] = px[src + 2]!;
      image.data[dst + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return out.toDataURL('image/png');
}

async function shoot(ids: string[]): Promise<Array<{ name: string; png: string }>> {
  const shots: Array<{ name: string; png: string }> = [];
  for (const id of ids) {
    const def = SCENES.find((scene) => scene.id === id);
    if (!def) throw new Error(`no scene "${id}"`);
    for (const [paletteName, palette] of Object.entries(PALETTES)) {
      for (const level of ['silence', 'calm', 'loud'] as const) {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const overlay = createSceneOverlay(canvas, { quality: 'high', seedKey: 'scene-shot', syncCompile: true });
        if (!overlay) throw new Error('no WebGL2');
        const gl = canvas.getContext('webgl2')!;
        overlay.resize(W, H, 1);
        overlay.setScene(def.id);
        // Two seconds of frames, so integrated clocks and envelopes settle.
        for (let i = 0; i < 60; i++) overlay.render(makeFrame(level, i * 0.033), palette, 33);
        if (overlay.currentSceneId() !== def.id) throw new Error(`${id} did not compile`);
        shots.push({ name: `${id}-${paletteName}-${level}`, png: toPng(gl) });
        overlay.dispose();
      }
    }
  }
  return shots;
}

(window as unknown as { __sceneShot: (ids: string[]) => Promise<unknown> }).__sceneShot = shoot;
