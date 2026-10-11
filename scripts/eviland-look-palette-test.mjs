// Look palettes are built in OKLCh: lightness is set per role, so the light
// colour is always lighter than the accent whatever the hue, no look gets an
// olive or brown dark, and the sleeve can turn a look's hues without changing
// how bright it is. Also pins the album-art side: the shadow tone is the
// vibrant hue at a fixed dark, and 'theme' resolves the same whichever host
// asks for it.
// Run: node scripts/eviland-look-palette-test.mjs
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
async function load(entry, name) {
  const outfile = resolve(`tmp/${name}.mjs`);
  await build({
    entryPoints: [resolve(entry)],
    bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile, logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}
const { generate, ARCHETYPES } = await load('src/visualizer/eviland-randomizer.ts', 'eviland-look-palette-rand-bundle');
const appearance = await load('src/visualizer/eviland-appearance.ts', 'eviland-look-palette-appearance-bundle');
const art = await load('src/visualizer/art-palette.ts', 'eviland-look-palette-art-bundle');
const { hashSeed } = await load('src/visualizer/eviland-rng.ts', 'eviland-look-palette-rng-bundle');
const { rgbToOklch, oklchToRgb, maxChroma, turnPaletteToHue, resolveEvilandPalette } = appearance;

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// --- the conversion itself ------------------------------------------------
// Reference values for the sRGB primaries in OKLCh.
const refs = [
  { name: 'red', rgb: [1, 0, 0], l: 0.628, c: 0.2577, h: 29.23 },
  { name: 'yellow', rgb: [1, 1, 0], l: 0.968, c: 0.2110, h: 109.77 },
  { name: 'blue', rgb: [0, 0, 1], l: 0.452, c: 0.3132, h: 264.05 },
];
for (const ref of refs) {
  const got = rgbToOklch(ref.rgb);
  if (!near(got.l, ref.l, 0.002) || !near(got.c, ref.c, 0.002) || hueGap(got.h, ref.h) > 0.3) {
    fail(`${ref.name}: expected OKLCh ${ref.l}/${ref.c}/${ref.h}, got ${got.l.toFixed(4)}/${got.c.toFixed(4)}/${got.h.toFixed(2)}`);
  }
}
const white = rgbToOklch([1, 1, 1]);
if (!near(white.l, 1, 0.001) || white.c > 0.001) fail(`white is not L 1 / C 0 (${white.l}, ${white.c})`);
{
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const rgb = [((i * 37) % 101) / 100, ((i * 53) % 103) / 102, ((i * 71) % 107) / 106];
    const o = rgbToOklch(rgb);
    const back = oklchToRgb(o.l, o.c, o.h);
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(back[k] - rgb[k]));
  }
  if (worst > 2e-3) fail(`sRGB -> OKLCh -> sRGB drifted by ${worst}`);
  log.push(`primaries match the reference; round trip within ${worst.toExponential(1)}`);
}
{
  // A request sRGB cannot show loses chroma but keeps lightness and hue.
  for (const [l, h] of [[0.5, 150], [0.9, 260], [0.3, 100], [0.95, 20]]) {
    const rgb = oklchToRgb(l, 0.4, h);
    if (rgb.some((v) => v < 0 || v > 1)) fail(`oklchToRgb(${l}, 0.4, ${h}) left the gamut`);
    const o = rgbToOklch(rgb);
    if (!near(o.l, l, 0.01) || hueGap(o.h, h) > 1.5) fail(`gamut mapping moved lightness/hue at L ${l} H ${h}: ${o.l.toFixed(3)}/${o.h.toFixed(1)}`);
    if (o.c > maxChroma(l, h) + 0.005) fail(`chroma ${o.c} above maxChroma ${maxChroma(l, h)} at L ${l} H ${h}`);
  }
  log.push('out-of-gamut colours keep lightness and hue');
}

// --- generated palettes ---------------------------------------------------
const PER_ARCHETYPE = 200;
const accentL = [];
let looks = 0;
let counted = 0;
let lightTooLow = 0;
let darkOut = 0;
let accentOut = 0;
let lightOut = 0;
let mud = 0;
let ink = 0;
for (const archetype of ARCHETYPES) {
  for (let k = 0; k < PER_ARCHETYPE; k++) {
    const config = generate(`palette::${archetype}::${k}`, archetype).config;
    const p = config.palette;
    looks++;
    const a = rgbToOklch(p.accent);
    const l = rgbToOklch(p.light);
    const d = rgbToOklch(p.dark);
    accentL.push(a.l);
    if (config.composition?.scene === 'data-raster') {
      // One-bit ink on black: every role is nearly colourless.
      ink++;
      if (p.bg.some((v) => v !== 0)) fail('data-raster background is not black');
      for (const [role, o] of [['accent', a], ['light', l], ['dark', d]]) {
        if (o.c > 0.02) fail(`data-raster ${role} has chroma ${o.c.toFixed(3)}`);
      }
      continue;
    }
    counted++;
    if (l.l < a.l + 0.1) lightTooLow++;
    if (a.l < 0.695 || a.l > 0.785) accentOut++;
    if (l.l < 0.895 || l.l > 0.965) lightOut++;
    if (d.l < 0.355 || d.l > 0.465) darkOut++;
    if (d.h > 50 && d.h < 115 && d.c > 0.03) mud++;
  }
}
const mean = accentL.reduce((s, v) => s + v, 0) / accentL.length;
const sd = Math.sqrt(accentL.reduce((s, v) => s + (v - mean) ** 2, 0) / accentL.length);
if (lightTooLow) fail(`${lightTooLow}/${counted} looks have a light role less than 0.1 lighter than the accent`);
if (accentOut) fail(`${accentOut}/${counted} accents sit outside L 0.70-0.78`);
if (lightOut) fail(`${lightOut}/${counted} light roles sit outside L 0.90-0.96`);
if (darkOut) fail(`${darkOut}/${counted} dark roles sit outside L 0.36-0.46`);
if (mud) fail(`${mud}/${counted} dark roles are olive or brown`);
if (sd >= 0.04) fail(`accent lightness varies too much across looks (sd ${sd.toFixed(3)})`);
if (ink === 0) fail('no data-raster look appeared in the sweep');
log.push(`${looks} looks over ${ARCHETYPES.length} archetypes: accent L sd ${sd.toFixed(3)}, light above accent in every look, no olive darks (${ink} ink looks held apart)`);

{
  // Same seed, same colours: the palette stays a pure function of the seed.
  const a = generate('palette-determinism', 'prism').config.palette;
  const b = generate('palette-determinism', 'prism').config.palette;
  if (JSON.stringify(a) !== JSON.stringify(b)) fail('a seed produced two different palettes');
}

// --- turning a palette to a hue ------------------------------------------
{
  const base = generate('palette-turn', 'nebula').config.palette;
  for (const hue of [10, 95, 200, 310]) {
    const turned = turnPaletteToHue(base, hue);
    const accent = rgbToOklch(turned.accent);
    if (hueGap(accent.h, hue) > 1.5) fail(`accent landed on ${accent.h.toFixed(1)} instead of ${hue}`);
    for (const role of ['bg', 'dark', 'accent', 'light']) {
      const before = rgbToOklch(base[role]);
      const after = rgbToOklch(turned[role]);
      if (!near(before.l, after.l, 0.012)) fail(`turning to ${hue} moved ${role} lightness ${before.l.toFixed(3)} -> ${after.l.toFixed(3)}`);
      if (after.c > before.c + 0.01) fail(`turning to ${hue} added chroma to ${role}`);
    }
  }
  // A cover in the olive range must not drag the dark role into it.
  for (const hue of [55, 70, 85, 100, 112]) {
    for (let k = 0; k < 20; k++) {
      const palette = generate(`palette-mud::${k}`, k % 2 ? 'nebula' : 'prism').config.palette;
      const dark = rgbToOklch(turnPaletteToHue(palette, hue).dark);
      if (dark.h > 50 && dark.h < 115 && dark.c > 0.03) fail(`turning to ${hue} left an olive dark (hue ${dark.h.toFixed(0)}, chroma ${dark.c.toFixed(3)})`);
    }
  }
  log.push('turning a palette keeps every role\'s lightness, never adds chroma and keeps the dark out of olive');
}

// --- the sleeve -----------------------------------------------------------
const RED_COVER = { vibrant: [0.85, 0.12, 0.1], secondary: [1, 0.55, 0.5], muted: art.shadowTone([0.85, 0.12, 0.1]) };
const coverHue = rgbToOklch(RED_COVER.vibrant).h;
{
  const THEME = { bg: [0.02, 0.02, 0.04], dark: [0.05, 0.3, 0.12], accent: [0.22, 1, 0.35], light: [0.9, 1, 0.92] };
  const look = generate('sleeve-look', 'prism').config.palette;
  if (resolveEvilandPalette('look', THEME, 0, 0, look) !== look) fail('a look without a sleeve is not returned as it is');
  if (resolveEvilandPalette('look', THEME, 0, 0, look, { art: null, seed: 'x' }) !== look) fail('a sleeve with no art changed the look');

  let followers = 0;
  let total = 0;
  for (let k = 0; k < 300; k++) {
    const config = generate(`sleeve::${k}`, k % 2 ? 'nebula' : 'prism').config;
    const got = resolveEvilandPalette('look', THEME, 0, 0, config.palette, { art: RED_COVER, seed: config.seed });
    total++;
    if (got === config.palette) continue;
    followers++;
    const accent = rgbToOklch(got.accent);
    if (hueGap(accent.h, coverHue) > 20) fail(`a following look landed ${hueGap(accent.h, coverHue).toFixed(0)} degrees off the cover`);
    const before = rgbToOklch(config.palette.accent);
    if (!near(accent.l, before.l, 0.012)) fail('following the sleeve changed the accent\'s lightness');
    // Asking again for the same look and sleeve decides the same way.
    const again = resolveEvilandPalette('look', THEME, 0, 0, config.palette, { art: RED_COVER, seed: config.seed });
    if (JSON.stringify(again) !== JSON.stringify(got)) fail('the same look and sleeve resolved two different palettes');
  }
  const share = followers / total;
  if (share < 0.4 || share > 0.6) fail(`${(share * 100).toFixed(0)}% of looks follow the sleeve; expected about half`);
  log.push(`red cover: ${followers}/${total} looks turn to the cover's hue, the rest are left alone`);
}
{
  const THEME = { bg: [0.02, 0.02, 0.04], dark: [0.05, 0.3, 0.12], accent: [0.22, 1, 0.35], light: [0.9, 1, 0.92] };
  // On-screen asks with the sleeve; Live and the projector hand over the
  // blended theme. Same colours either way.
  for (const keyShift of [0, 0.125]) {
    const onScreen = resolveEvilandPalette('theme', THEME, 3, keyShift, null, { art: RED_COVER, seed: 'whatever' });
    const live = resolveEvilandPalette('theme', art.blendPaletteWithArt(THEME, RED_COVER), 3, keyShift, null);
    if (JSON.stringify(onScreen) !== JSON.stringify(live)) fail(`theme mode differs between hosts at key shift ${keyShift}`);
  }
  if (resolveEvilandPalette('theme', THEME, 0, 0, null, { art: null, seed: 'x' }) !== THEME) fail('theme with no art is not the theme');
  const blended = art.blendPaletteWithArt(THEME, RED_COVER);
  if (JSON.stringify(blended.bg) !== JSON.stringify(THEME.bg)) fail('blending art changed the background');
  log.push('theme mode resolves the same on-screen, in Live and in the projector');
}
{
  // The shadow tone is the vibrant hue, dark and quiet, not the image mean.
  for (const vibrant of [[0.85, 0.12, 0.1], [0.1, 0.6, 0.9], [0.9, 0.8, 0.1], [0.3, 0.8, 0.3]]) {
    const tone = art.shadowTone(vibrant);
    const o = rgbToOklch(tone);
    const v = rgbToOklch(vibrant);
    if (!near(o.l, 0.38, 0.012)) fail(`shadow tone lightness ${o.l.toFixed(3)}, expected 0.38`);
    if (!near(o.c, 0.08, 0.01)) fail(`shadow tone chroma ${o.c.toFixed(3)}, expected 0.08`);
    if (hueGap(o.h, v.h) > 2) fail(`shadow tone hue ${o.h.toFixed(0)} is not the vibrant hue ${v.h.toFixed(0)}`);
  }
  log.push('shadow tone: vibrant hue at OKLCh L 0.38, C 0.08');
}

// --- caches follow the colours, not the object ----------------------------
// The Director lerps a look's palette in place every frame, so one object holds
// different colours from call to call. A cache keyed on the object would hand
// back the first frame's colours for the whole fade.
const ROLES = ['bg', 'dark', 'accent', 'light'];
const copy = (value) => JSON.parse(JSON.stringify(value));
{
  const THEME = { bg: [0.02, 0.02, 0.04], dark: [0.05, 0.3, 0.12], accent: [0.22, 1, 0.35], light: [0.9, 1, 0.92] };
  let followSeed = null;
  for (let k = 0; k < 40 && followSeed === null; k++) {
    if (hashSeed(`cache::${k}::sleeve`) % 2 === 0) followSeed = `cache::${k}`;
  }
  const from = generate('cache-from', 'nebula').config.palette;
  const to = generate('cache-to', 'prism').config.palette;
  const live = copy(from);
  const sleeve = { art: RED_COVER, seed: followSeed };

  const first = resolveEvilandPalette('look', THEME, 0, 0, live, sleeve);
  if (first === live) fail('the seed picked to follow the sleeve left the look alone');
  if (resolveEvilandPalette('look', THEME, 0, 0, live, sleeve) !== first) fail('an unchanged look palette was turned again');
  for (const t of [0.25, 0.5, 0.8, 1]) {
    for (const role of ROLES) for (let i = 0; i < 3; i++) live[role][i] = from[role][i] + (to[role][i] - from[role][i]) * t;
    const got = resolveEvilandPalette('look', THEME, 0, 0, live, sleeve);
    if (JSON.stringify(got) !== JSON.stringify(turnPaletteToHue(copy(live), coverHue))) fail(`a look palette edited in place (t = ${t}) resolved to stale colours`);
  }

  // Theme mode: the theme edited in place, the cover edited in place, and the key shift.
  for (const keyShift of [0, 0.125]) {
    const theme = copy(THEME);
    const cover = copy(RED_COVER);
    const withSleeve = { art: cover, seed: 'theme-cache' };
    resolveEvilandPalette('theme', theme, 3, keyShift, null, withSleeve);
    theme.accent[0] = 0.8;
    theme.dark[2] = 0.4;
    const afterTheme = resolveEvilandPalette('theme', theme, 3, keyShift, null, withSleeve);
    const wantTheme = resolveEvilandPalette('theme', art.blendPaletteWithArt(copy(theme), copy(cover)), 3, keyShift, null);
    if (JSON.stringify(afterTheme) !== JSON.stringify(wantTheme)) fail(`theme mode kept stale colours after the theme was edited in place (key shift ${keyShift})`);
    cover.vibrant[0] = 0.1;
    cover.muted[1] = 0.5;
    const afterCover = resolveEvilandPalette('theme', theme, 3, keyShift, null, withSleeve);
    const wantCover = resolveEvilandPalette('theme', art.blendPaletteWithArt(copy(theme), copy(cover)), 3, keyShift, null);
    if (JSON.stringify(afterCover) !== JSON.stringify(wantCover)) fail(`theme mode kept stale colours after the cover was edited in place (key shift ${keyShift})`);
  }
  {
    // No sleeve: the key shift alone is cached on the theme.
    const theme = copy(THEME);
    resolveEvilandPalette('theme', theme, 3, 0.125, null);
    theme.accent[1] = 0.5;
    theme.light[0] = 0.3;
    const got = resolveEvilandPalette('theme', theme, 3, 0.125, null);
    const want = resolveEvilandPalette('theme', copy(theme), 3, 0.125, null);
    if (JSON.stringify(got) !== JSON.stringify(want)) fail('a key-shifted theme edited in place resolved to stale colours');
    if (resolveEvilandPalette('theme', theme, 3, 0.125, null) !== got) fail('an unchanged key-shifted theme was shifted again');
  }

  // A sleeve seed of '' decides like any other: a fresh module has not seen one yet.
  const fresh = await import(pathToFileURL(resolve('tmp/eviland-look-palette-appearance-bundle.mjs')).href + '?empty-seed');
  const emptyFollows = hashSeed('::sleeve') % 2 === 0;
  const look = generate('empty-seed', 'prism').config.palette;
  const resolved = fresh.resolveEvilandPalette('look', THEME, 0, 0, look, { art: RED_COVER, seed: '' });
  if ((resolved !== look) !== emptyFollows) fail(`an empty sleeve seed ${emptyFollows ? 'should follow' : 'should not follow'} the cover`);
  log.push(`palette caches follow in-place edits (look, theme, cover, key shift); an empty sleeve seed ${emptyFollows ? 'follows' : 'leaves the look'}`);
}

console.log(log.join('\n'));
console.log(pass ? '[eviland-look-palette-test] PASS' : '[eviland-look-palette-test] FAIL');
process.exitCode = pass ? 0 : 1;
