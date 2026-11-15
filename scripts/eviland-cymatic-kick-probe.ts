// Browser-side half of scripts/eviland-cymatic-kick-test.mjs. Every twelfth
// counted kick re-tunes the Cymatic Plate, and the old figure has to give way
// to the new one from the kick's own age: on the frame the count moves the
// picture must still be the old figure, whether the kick was hard or soft. The
// same audio is played twice, the twelfth kick hard and soft, and how far the
// picture jumps on that frame is measured against the frame before it.
import { createSceneOverlay } from '../src/visualizer/scene-overlay';
import type { EvilandFrame } from '../src/visualizer/eviland-audio';
import type { EvilandPalette } from '../src/visualizer/eviland';

const W = 160;
const H = 90;
const FPS = 60;
const FRAMES_PER_KICK = 24;

const PALETTE: EvilandPalette = { accent: [0.22, 1.0, 0.35], dark: [0.05, 0.3, 0.12], light: [0.9, 1.0, 0.92], bg: [0.02, 0.02, 0.04] };

function frame(t: number, kick: number | null): EvilandFrame {
  const bands = new Float32Array(24);
  for (let i = 0; i < 24; i++) bands[i] = 0.55 + 0.1 * Math.sin(i * 0.9);
  return {
    bands,
    onsets: kick === null ? [] : [{ band: 1, group: 'kick', intensity: kick, sharpness: 0.8 }],
    kick: 0.5, bass: 0.5, snare: 0, hat: 0, vocal: 0.2, energy: 0.6,
    centroid: 0.5, flatness: 0.3, noisiness: 0.2, crest: 0.5, rolloff: 0.5, width: 0.4, pan: 0,
    beatPhase: (t * 2.5) % 1, beatConfidence: 0.8, bpm: 150, novelty: 0,
    sectionId: 1, sectionChanged: false, sectionReturn: -1, sectionFingerprint: null,
  };
}

function pixels(gl: WebGL2RenderingContext): Uint8Array {
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

function meanDifference(a: Uint8Array, b: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 4) total += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
  return total / ((a.length / 4) * 3);
}

/** The picture on the frame before the twelfth counted kick and on the frame that carries it. */
function twelfthKick(intensity: number): { before: Uint8Array; on: Uint8Array } {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const overlay = createSceneOverlay(canvas, { quality: 'high', seedKey: 'cymatic-kick', syncCompile: true });
  if (!overlay) throw new Error('no WebGL2');
  const gl = canvas.getContext('webgl2')!;
  overlay.resize(W, H, 1);
  overlay.setScene('cymatic-plate');
  const dt = 1000 / FPS;
  let step = 0;
  const render = (kick: number | null): Uint8Array => {
    overlay.render(frame(step / FPS, kick), PALETTE, dt);
    step += 1;
    return pixels(gl);
  };
  for (let kick = 1; kick <= 11; kick++) {
    render(0.9);
    for (let i = 1; i < FRAMES_PER_KICK; i++) render(null);
  }
  for (let i = 0; i < FRAMES_PER_KICK - 1; i++) render(null);
  const before = render(null);
  const on = render(intensity);
  if (overlay.currentSceneId() !== 'cymatic-plate') throw new Error('the Cymatic Plate did not compile');
  overlay.dispose();
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { before, on };
}

async function kickJumps() {
  const hard = twelfthKick(1);
  const soft = twelfthKick(0.3);
  const failures: string[] = [];
  // The runs share every frame up to the twelfth kick, so these two are the same picture.
  const shared = meanDifference(hard.before, soft.before);
  const hardJump = meanDifference(hard.before, hard.on);
  const softJump = meanDifference(soft.before, soft.on);
  if (shared > 0.01) failures.push(`the runs differ before the kick (${shared.toFixed(3)} levels apart)`);
  if (hardJump < 0.01) failures.push(`the picture did not move on the kick at all (${hardJump.toFixed(3)} levels)`);
  // A soft kick may light the rim less than a hard one, never move the figure more.
  if (softJump > hardJump * 1.25 + 0.25) failures.push(`a soft twelfth kick jumps the picture ${softJump.toFixed(2)} levels against ${hardJump.toFixed(2)} for a hard one`);
  return { failures, shared, hardJump, softJump };
}

(window as unknown as { __cymaticKick: typeof kickJumps }).__cymaticKick = kickJumps;
