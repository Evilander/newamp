// Sonic Atlas — project the library's per-track Audio DNA (11-dim
// perceptual feature vector) down to 2D so the user can navigate the
// collection as a sonic territory. Same library produces the same map
// across launches: PCA is deterministic, and power iteration's seed is
// fixed.
//
// This is the inventive layer on top of Audio DNA. iTunes, Roon, Plexamp,
// Spotify don't project the personal library to a 2D acoustic plane the
// user can walk. The closest precedent is research-paper "music maps"
// (Pampalk et al. 2002, "Islands of Music"; Knees 2008) and the
// recommendation literature, but those are usually genre/embedding-driven
// rather than user-content-fingerprint-driven.
//
// Implementation: zero-deps PCA via power iteration + Hotelling deflation
// over the centered covariance matrix. 11 dims, trivial cost; runs in
// ~10 ms on 12 000 tracks. Future projections (UMAP / t-SNE) can swap in
// behind the SonicAtlas shape.

import { dnaToVector, type TrackDna } from './audio-dna.js';

export const SONIC_ATLAS_VERSION = 1;

export interface AtlasPoint {
  id: number;
  x: number;      // normalized 0..1 in the projected plane
  y: number;      // normalized 0..1 in the projected plane
  dna: TrackDna;
}

export interface SonicAtlas {
  v: typeof SONIC_ATLAS_VERSION;
  projection: 'pca';
  points: AtlasPoint[];
  axes: {
    x: { hint: string; loadings: number[] };
    y: { hint: string; loadings: number[] };
  };
  generatedAt: number;
}

export interface AtlasInput {
  id: number;
  dna: TrackDna;
}

const AXIS_DIM_NAMES = [
  'rms',
  'dynRng',
  'bright',
  'flat',
  'rolloff',
  'onset',
  'low',
  'lowMid',
  'mid',
  'highMid',
  'high',
];

export function buildSonicAtlas(input: AtlasInput[]): SonicAtlas {
  const generatedAt = Date.now();
  if (input.length < 3) {
    return {
      v: SONIC_ATLAS_VERSION,
      projection: 'pca',
      points: input.map((row) => ({ id: row.id, x: 0.5, y: 0.5, dna: row.dna })),
      axes: { x: { hint: 'too few tracks', loadings: [] }, y: { hint: 'too few tracks', loadings: [] } },
      generatedAt,
    };
  }
  const vectors = input.map((row) => dnaToVector(row.dna));
  const n = vectors.length;
  const d = vectors[0]!.length;

  // 1. Center
  const mean = new Array<number>(d).fill(0);
  for (const v of vectors) for (let i = 0; i < d; i++) mean[i]! += v[i]!;
  for (let i = 0; i < d; i++) mean[i]! /= n;
  const centered: number[][] = vectors.map((v) => v.map((x, i) => x - mean[i]!));

  // 2. Covariance matrix d × d (sample covariance, denominator n-1)
  const cov = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (const v of centered) {
    for (let i = 0; i < d; i++) {
      const vi = v[i]!;
      for (let j = i; j < d; j++) {
        cov[i]![j]! += vi * v[j]!;
      }
    }
  }
  for (let i = 0; i < d; i++) {
    for (let j = i; j < d; j++) {
      cov[i]![j]! /= n - 1;
      cov[j]![i]! = cov[i]![j]!;
    }
  }

  // 3. Power iteration for top eigenvector, deflate, repeat for second.
  const v1 = powerIteration(cov, d);
  const cov2 = hotellingDeflate(cov, v1);
  const v2 = powerIteration(cov2, d);
  // Orthogonalize v2 against v1 just in case of numerical drift.
  const v2Ortho = normalize(subtractProjection(v2, v1));

  // 4. Project and normalize the spread into [0, 1] with a 4% inset so
  //    boundary dots aren't clipped against the canvas edge.
  const xs = centered.map((v) => dot(v, v1));
  const ys = centered.map((v) => dot(v, v2Ortho));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xRange = Math.max(1e-9, xMax - xMin);
  const yRange = Math.max(1e-9, yMax - yMin);
  const inset = 0.04;
  const points: AtlasPoint[] = input.map((row, i) => ({
    id: row.id,
    x: inset + ((xs[i]! - xMin) / xRange) * (1 - 2 * inset),
    y: inset + ((ys[i]! - yMin) / yRange) * (1 - 2 * inset),
    dna: row.dna,
  }));

  return {
    v: SONIC_ATLAS_VERSION,
    projection: 'pca',
    points,
    axes: {
      x: { hint: hintFromLoadings(v1), loadings: roundLoadings(v1) },
      y: { hint: hintFromLoadings(v2Ortho), loadings: roundLoadings(v2Ortho) },
    },
    generatedAt,
  };
}

function powerIteration(M: number[][], d: number, iterations = 60): number[] {
  // Deterministic seed: use a small fixed irrational-looking start so
  // repeated calls on the same matrix yield byte-identical eigenvectors.
  let v = new Array<number>(d).fill(0).map((_, i) => Math.sin((i + 1) * 1.61803));
  v = normalize(v);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Array<number>(d).fill(0);
    for (let i = 0; i < d; i++) {
      let s = 0;
      const row = M[i]!;
      for (let j = 0; j < d; j++) s += row[j]! * v[j]!;
      next[i] = s;
    }
    const nn = normalize(next);
    // Force sign so we get the same orientation between runs.
    if (nn[indexOfMaxAbs(nn)]! < 0) for (let i = 0; i < d; i++) nn[i] = -nn[i]!;
    v = nn;
  }
  return v;
}

function hotellingDeflate(M: number[][], v: number[]): number[][] {
  const d = v.length;
  // lambda = v^T M v
  let lambda = 0;
  for (let i = 0; i < d; i++) {
    let mi = 0;
    const row = M[i]!;
    for (let j = 0; j < d; j++) mi += row[j]! * v[j]!;
    lambda += v[i]! * mi;
  }
  return Array.from({ length: d }, (_, i) =>
    Array.from({ length: d }, (_, j) => M[i]![j]! - lambda * v[i]! * v[j]!),
  );
}

function subtractProjection(v: number[], onto: number[]): number[] {
  const k = dot(v, onto);
  return v.map((x, i) => x - k * onto[i]!);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function normalize(v: number[]): number[] {
  let sq = 0;
  for (const x of v) sq += x * x;
  const mag = Math.sqrt(sq);
  if (mag === 0) return v.slice();
  return v.map((x) => x / mag);
}

function indexOfMaxAbs(v: number[]): number {
  let idx = 0;
  let best = -1;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]!);
    if (a > best) {
      best = a;
      idx = i;
    }
  }
  return idx;
}

function roundLoadings(v: number[]): number[] {
  return v.map((x) => Math.round(x * 1000) / 1000);
}

function hintFromLoadings(v: number[]): string {
  // Surface the two biggest-magnitude DNA dimensions per axis so the UI can
  // label what the axis "means" sonically — e.g., "brightness vs low-band".
  const pairs = v
    .map((value, idx) => ({ idx, value, mag: Math.abs(value) }))
    .sort((a, b) => b.mag - a.mag);
  const top = pairs.slice(0, 2);
  const labels = top.map((p) => `${p.value >= 0 ? '+' : '-'}${AXIS_DIM_NAMES[p.idx]!}`);
  return labels.join(' & ');
}

export function nearestAtlasPoint(atlas: SonicAtlas, x: number, y: number, maxDist = 0.02): AtlasPoint | null {
  let best: AtlasPoint | null = null;
  let bestDist = maxDist * maxDist;
  for (const point of atlas.points) {
    const dx = point.x - x;
    const dy = point.y - y;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = point;
    }
  }
  return best;
}

export function atlasPointColor(point: AtlasPoint): string {
  // HSL keyed on brightness (hue) + bands (saturation/lightness) so similar
  // tracks render in similar colors and the cluster structure reads
  // visually even without labels.
  const dna = point.dna;
  const hue = (dna.brightness * 220 + dna.bands[2]! * 60) % 360;
  const sat = 60 + dna.dynamicRange * 30;
  const light = 38 + dna.bands[0]! * 30;
  return `hsl(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${light.toFixed(0)}%)`;
}
