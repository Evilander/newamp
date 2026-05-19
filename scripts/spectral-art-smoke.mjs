import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  spectralArtSvg,
  spectralArtDataUrl,
  spectralArtPalette,
} from '../dist-electron/shared/spectral-art.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outRoot = join(repoRoot, 'tmp', 'spectral-art-smoke');
await rm(outRoot, { recursive: true, force: true });
await mkdir(outRoot, { recursive: true });

const seeds = [
  { artist: 'Hella', album: 'There\'s No 666 in Outer Space' },
  { artist: 'Pink Floyd', album: 'The Dark Side of the Moon' },
  { artist: 'Built to Spill', album: 'Keep It Like a Secret' },
  { artist: 'Dave Brubeck Quartet', album: 'Time Out' },
  { artist: 'Wilco', album: 'Yankee Hotel Foxtrot' },
  { artist: 'Aphex Twin', album: 'Selected Ambient Works 85-92' },
];

const renders = seeds.map((seed) => ({
  seed,
  svg: spectralArtSvg(seed, 320),
  palette: spectralArtPalette(seed),
}));

// Determinism: same seed → byte-identical output
for (const item of renders) {
  const again = spectralArtSvg(item.seed, 320);
  assert.equal(again, item.svg, `spectral SVG should be deterministic for ${item.seed.artist} / ${item.seed.album}`);
}

// Different seeds should produce different palettes (at least most of the time)
const uniquePalettes = new Set(renders.map((r) => r.palette.accent));
assert.ok(uniquePalettes.size >= seeds.length - 1, 'distinct albums should mostly produce distinct accent colors');

// Output is a valid SVG-ish string
for (const item of renders) {
  assert.ok(item.svg.startsWith('<svg'), 'output should start with <svg');
  assert.ok(item.svg.includes('</svg>'), 'output should close with </svg>');
  assert.ok(item.svg.includes('linearGradient'), 'gradient should be defined');
  assert.ok(item.svg.includes(item.palette.bg1), 'palette colors should appear in svg');
  assert.ok(/[<>&]/.test(item.svg), 'svg should contain markup');
}

// Data URL form is encoded
const dataUrl = spectralArtDataUrl(seeds[0]);
assert.ok(dataUrl.startsWith('data:image/svg+xml;utf8,'), 'data URL prefix should be set');
assert.ok(decodeURIComponent(dataUrl.slice('data:image/svg+xml;utf8,'.length)).startsWith('<svg'), 'data URL should round-trip to svg');

// Empty / missing seeds shouldn't crash
const noAlbum = spectralArtSvg({ artist: '', album: '' });
assert.ok(noAlbum.startsWith('<svg'));
assert.ok(noAlbum.includes('UNKNOWN'), 'empty seed should still print a placeholder label');

// HTML escaping
const naughty = spectralArtSvg({ artist: 'Boards <of> "Canada"', album: 'Music & Stuff' });
assert.ok(naughty.includes('&amp;'), 'ampersand should be escaped');
assert.ok(naughty.includes('&lt;'), 'angle brackets should be escaped');
assert.ok(!naughty.includes('"Canada"'), 'embedded quotes should be encoded');

for (const item of renders) {
  const filename = sanitizeFile(`${item.seed.artist}-${item.seed.album}.svg`);
  await writeFile(join(outRoot, filename), item.svg, 'utf8');
}

const albumViewSource = await readFile(new URL('../src/components/views/AlbumsView.tsx', import.meta.url), 'utf8');
const foldersViewSource = await readFile(new URL('../src/components/views/FoldersView.tsx', import.meta.url), 'utf8');
const sharedSource = await readFile(new URL('../shared/spectral-art.ts', import.meta.url), 'utf8');
assert.match(sharedSource, /spectralArtSvg/);
assert.match(albumViewSource, /spectralArtDataUrl/);
assert.match(foldersViewSource, /spectralArtDataUrl/);

console.log(JSON.stringify({
  ok: true,
  outRoot,
  rendered: renders.length,
  palettes: renders.map((r) => ({ seed: `${r.seed.artist} — ${r.seed.album}`, ...r.palette })),
}, null, 2));

function sanitizeFile(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}
