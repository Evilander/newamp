import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SONIC_ATLAS_VERSION,
  atlasPointColor,
  buildSonicAtlas,
  nearestAtlasPoint,
  nearestAtlasPoints,
} from '../dist-electron/shared/sonic-atlas.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeDir = join(repoRoot, 'tmp', `sonic-atlas-smoke-${process.pid}-${Date.now()}`);
await rm(smokeDir, { recursive: true, force: true });

// Build a deterministic synthetic library: three sonic clusters in DNA space.
function dnaForCluster(rng, cluster) {
  const base = { bright: 0.2, low: 0.6, dyn: 0.4 };
  if (cluster === 'bright') Object.assign(base, { bright: 0.85, low: 0.1, dyn: 0.6 });
  if (cluster === 'punchy') Object.assign(base, { bright: 0.45, low: 0.55, dyn: 0.9 });
  return {
    v: 1,
    framesAnalyzed: 60,
    secondsAnalyzed: 3,
    rms: clip(base.dyn + rng() * 0.05),
    dynamicRange: clip(base.dyn + rng() * 0.05),
    brightness: clip(base.bright + rng() * 0.05),
    flatness: clip(0.4 + rng() * 0.05),
    bands: [
      clip(base.low + rng() * 0.05),
      clip(0.3 + rng() * 0.05),
      clip(0.25 + rng() * 0.05),
      clip(base.bright * 0.6 + rng() * 0.05),
      clip(base.bright * 0.4 + rng() * 0.05),
    ],
    onsetDensity: clip(0.3 + base.dyn * 0.4 + rng() * 0.05),
    rolloff: clip(base.bright * 0.8 + rng() * 0.05),
  };
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s & 0xffffff) / 0xffffff;
  };
}

function clip(v) {
  return Math.max(0, Math.min(1, v));
}

const rng = makeRng(42);
const input = [];
for (let i = 0; i < 200; i++) input.push({ id: i + 1, dna: dnaForCluster(rng, 'low') });
for (let i = 0; i < 200; i++) input.push({ id: 1000 + i, dna: dnaForCluster(rng, 'bright') });
for (let i = 0; i < 200; i++) input.push({ id: 2000 + i, dna: dnaForCluster(rng, 'punchy') });

const atlas = buildSonicAtlas(input);
assert.equal(atlas.v, SONIC_ATLAS_VERSION);
assert.equal(atlas.projection, 'pca');
assert.equal(atlas.points.length, input.length);

// Determinism: same input → same projection.
const atlas2 = buildSonicAtlas(input);
for (let i = 0; i < atlas.points.length; i++) {
  assert.ok(
    Math.abs(atlas.points[i].x - atlas2.points[i].x) < 1e-9 &&
      Math.abs(atlas.points[i].y - atlas2.points[i].y) < 1e-9,
    `point ${i} is not deterministic`,
  );
}

// Coordinates clamped into [0, 1].
for (const p of atlas.points) {
  assert.ok(p.x >= 0 && p.x <= 1, `x out of range: ${p.x}`);
  assert.ok(p.y >= 0 && p.y <= 1, `y out of range: ${p.y}`);
}

// Clusters separate: the three groups should have visibly different mean coordinates.
function clusterCentroid(ids) {
  const set = new Set(ids);
  const cluster = atlas.points.filter((p) => set.has(p.id));
  const sumX = cluster.reduce((s, p) => s + p.x, 0);
  const sumY = cluster.reduce((s, p) => s + p.y, 0);
  return { x: sumX / cluster.length, y: sumY / cluster.length };
}
const lowIds = input.slice(0, 200).map((row) => row.id);
const brightIds = input.slice(200, 400).map((row) => row.id);
const punchyIds = input.slice(400, 600).map((row) => row.id);
const cLow = clusterCentroid(lowIds);
const cBright = clusterCentroid(brightIds);
const cPunchy = clusterCentroid(punchyIds);
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
const minPairwise = Math.min(dist(cLow, cBright), dist(cLow, cPunchy), dist(cBright, cPunchy));
assert.ok(minPairwise > 0.15, `clusters too close: min pairwise centroid distance ${minPairwise.toFixed(3)}`);

// Nearest-point hit testing.
const target = atlas.points[50];
const found = nearestAtlasPoint(atlas, target.x, target.y, 0.05);
assert.equal(found?.id, target.id, 'nearestAtlasPoint should resolve to the same track');
const missed = nearestAtlasPoint(atlas, 2, 2, 0.05);
assert.equal(missed, null, 'nearestAtlasPoint should return null for far-away coords');

// nearestAtlasPoints — "play this region" contract.
{
  const ten = nearestAtlasPoints(atlas, target.x, target.y, 10);
  assert.equal(ten.length, 10, 'nearestAtlasPoints should return the requested count when atlas has enough points');
  assert.equal(ten[0].id, target.id, 'nearestAtlasPoints[0] must be the closest point (the seed itself when on-grid)');

  // Monotonic squared-distance ordering — index i must be no farther than index i+1.
  let prevDist = -Infinity;
  for (const point of ten) {
    const dx = point.x - target.x;
    const dy = point.y - target.y;
    const dist = dx * dx + dy * dy;
    assert.ok(dist >= prevDist, `nearestAtlasPoints must be sorted ascending by distance; got ${dist} after ${prevDist}`);
    prevDist = dist;
  }

  // Clamp upper bound — count > 500 must collapse to 500, regardless of atlas size.
  const clamped = nearestAtlasPoints(atlas, target.x, target.y, 9999);
  assert.ok(clamped.length <= 500, `nearestAtlasPoints must clamp count to 500, got ${clamped.length}`);
  assert.equal(clamped.length, Math.min(500, atlas.points.length), 'nearestAtlasPoints should saturate at 500 when atlas is large');

  // Clamp lower bound — count <= 0 must still return one point (the floor protects UI handlers from "" inputs).
  const floored = nearestAtlasPoints(atlas, target.x, target.y, 0);
  assert.equal(floored.length, 1, `nearestAtlasPoints(count=0) must floor to 1, got ${floored.length}`);
  const negative = nearestAtlasPoints(atlas, target.x, target.y, -3);
  assert.equal(negative.length, 1, `nearestAtlasPoints(count<0) must floor to 1, got ${negative.length}`);

  // Far-away origin still returns ordered nearest points (no maxDist gate on this API).
  const farAway = nearestAtlasPoints(atlas, 5, 5, 5);
  assert.equal(farAway.length, 5, 'nearestAtlasPoints has no maxDist gate — should still return count items');
}

// Color is a valid hsl() string.
const color = atlasPointColor(atlas.points[0]);
assert.match(color, /^hsl\(\d+,\s*\d+%,\s*\d+%\)$/, `atlasPointColor format: ${color}`);

// Axis hints surface the dominant DNA dimensions.
assert.ok(atlas.axes.x.hint.length > 0);
assert.ok(atlas.axes.y.hint.length > 0);
assert.notEqual(atlas.axes.x.hint, atlas.axes.y.hint, 'x and y axes should describe different loadings');

// Edge cases.
const tiny = buildSonicAtlas(input.slice(0, 2));
assert.equal(tiny.points.length, 2);
for (const p of tiny.points) assert.equal(p.x, 0.5);

const sonicAtlasSource = await readFile(new URL('../shared/sonic-atlas.ts', import.meta.url), 'utf8');
assert.match(sonicAtlasSource, /power iteration/i, 'shared module documents the projection method');
assert.match(sonicAtlasSource, /Pampalk/i, 'shared module cites the academic precedent it builds on');

console.log(JSON.stringify({
  ok: true,
  total: atlas.points.length,
  centroids: { low: cLow, bright: cBright, punchy: cPunchy },
  minPairwiseDistance: +minPairwise.toFixed(3),
  axes: atlas.axes,
}, null, 2));
