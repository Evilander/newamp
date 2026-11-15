// Look palettes are built in OKLCh: lightness is set per role, so the light
// colour is always lighter than the accent whatever the hue, no look gets an
// olive or brown dark, and the sleeve can turn a look's hues without changing
// how bright it is. Each look carries a second accent whose hue sits a
// scheme's distance from the first. Also pins the album-art side: the pixels of
// a cover go through OKLCh, the shadow tone is the vibrant hue at a fixed dark,
// and 'theme' resolves the same whichever host asks for it.
// Run: node scripts/eviland-look-palette-test.mjs
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
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
const { generate, mutate, ARCHETYPES, SCHEME_PARTNER_DEGREES } = await load('src/visualizer/eviland-randomizer.ts', 'eviland-look-palette-rand-bundle');
const appearance = await load('src/visualizer/eviland-appearance.ts', 'eviland-look-palette-appearance-bundle');
const art = await load('src/visualizer/art-palette.ts', 'eviland-look-palette-art-bundle');
const { SCENES } = await load('src/visualizer/scenes/index.ts', 'eviland-look-palette-scenes-bundle');
const { hashSeed } = await load('src/visualizer/eviland-rng.ts', 'eviland-look-palette-rng-bundle');
const { createConductor } = await load('src/visualizer/eviland-conductor.ts', 'eviland-look-palette-conductor-bundle');
const { rgbToOklch, oklchToRgb, maxChroma, turnPaletteToHue, resolveEvilandPalette, accentPair, moodShift, themePaletteFromAccent, mixOklch } = appearance;

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
  // A colour sRGB can show comes back as itself. Near the blue primary the ray
  // from grey leaves sRGB and re-enters, so the gamut edge found from grey is
  // not where the colour stops: every 8-bit corner, the whole blue edge, the
  // saturated blue pocket and a random sample must round-trip to the same byte.
  const roundTrip = (r, g, b) => {
    const o = rgbToOklch([r / 255, g / 255, b / 255]);
    const back = oklchToRgb(o.l, o.c, o.h).map((v) => Math.round(v * 255));
    return back[0] === r && back[1] === g && back[2] === b ? null : `${r},${g},${b} came back as ${back.join(',')}`;
  };
  const misses = [];
  const check = (r, g, b) => {
    const miss = roundTrip(r, g, b);
    if (miss && misses.length < 5) misses.push(miss);
    return miss ? 1 : 0;
  };
  let checked = 0;
  let wrong = 0;
  for (const r of [0, 255]) for (const g of [0, 255]) for (const b of [0, 255]) { wrong += check(r, g, b); checked++; }
  for (let b = 0; b < 256; b++) { wrong += check(0, 0, b); checked++; }
  for (let r = 0; r < 26; r++) for (let g = 0; g < 26; g++) for (let b = 76; b < 256; b++) { wrong += check(r, g, b); checked++; }
  let state = 0x2545f491;
  const byte = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 24; };
  for (let i = 0; i < 50000; i++) { wrong += check(byte(), byte(), byte()); checked++; }
  if (wrong) fail(`${wrong} of ${checked} 8-bit colours did not survive sRGB -> OKLCh -> sRGB: ${misses.join('; ')}`);
  log.push(`${checked} 8-bit colours (corners, blue edge, blue pocket, random) round-trip to the same byte`);
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
let bgOut = 0;
let accent2Out = 0;
let accent2Gamut = 0;
let accent2Dull = 0;
let accent2Gap = 0;
let distinctPairs = 0;
let monoPairs = 0;
let accent2Same = 0;
const PARTNER_ANGLES = [...new Set(Object.values(SCHEME_PARTNER_DEGREES))];
for (const archetype of ARCHETYPES) {
  for (let k = 0; k < PER_ARCHETYPE; k++) {
    const config = generate(`palette::${archetype}::${k}`, archetype).config;
    const p = config.palette;
    looks++;
    const a = rgbToOklch(p.accent);
    const l = rgbToOklch(p.light);
    const d = rgbToOklch(p.dark);
    const b = rgbToOklch(p.bg);
    accentL.push(a.l);
    if (!p.accent2) fail(`look ${archetype}/${k} has no second accent`);
    if (config.composition?.scene === 'data-raster') {
      // One-bit ink on black: every role is nearly colourless.
      ink++;
      if (p.bg.some((v) => v !== 0)) fail('data-raster background is not black');
      for (const [role, o] of [['accent', a], ['light', l], ['dark', d], ['accent2', rgbToOklch(p.accent2)]]) {
        if (o.c > 0.02) fail(`data-raster ${role} has chroma ${o.c.toFixed(3)}`);
      }
      continue;
    }
    counted++;
    if (l.l < a.l + 0.1) lightTooLow++;
    // The archetypes' lightness offsets widen the accent band by 0.04 each way
    // and the light band by 0.02 below; the gap rule above still holds.
    if (a.l < 0.655 || a.l > 0.825) accentOut++;
    if (l.l < 0.875 || l.l > 0.98) lightOut++;
    if (d.l < 0.355 || d.l > 0.465) darkOut++;
    if (d.h > 50 && d.h < 115 && d.c > 0.03) mud++;
    // The background sits in the designed dark band whatever its hue, give or
    // take the rounding of the sRGB round trip.
    if (b.l < 0.095 || b.l > 0.185) bgOut++;
    // The second accent: the accent's weight of colour, a scheme's distance away.
    const a2 = rgbToOklch(p.accent2);
    if (a2.l < 0.655 || a2.l > 0.825) accent2Out++;
    const gap = hueGap(a.h, a2.h);
    if (p.accent2.some((v) => v < 0 || v > 1)) accent2Gamut++;
    // Chroma share of what sRGB can show at its own lightness and hue: 0.9 of the accent's.
    const share = a.c / maxChroma(a.l, a.h);
    const share2 = a2.c / maxChroma(a2.l, a2.h);
    if (Math.abs(share2 - 0.9 * share) > 0.05) accent2Dull++;
    if (!PARTNER_ANGLES.some((angle) => Math.abs(gap - angle) <= 15)) accent2Gap++;
    if (gap > 15) distinctPairs++; else monoPairs++;
    if (Math.abs(a2.l - a.l) < 0.02 && gap < 15) accent2Same++;
  }
}
const mean = accentL.reduce((s, v) => s + v, 0) / accentL.length;
const sd = Math.sqrt(accentL.reduce((s, v) => s + (v - mean) ** 2, 0) / accentL.length);
if (lightTooLow) fail(`${lightTooLow}/${counted} looks have a light role less than 0.1 lighter than the accent`);
if (accentOut) fail(`${accentOut}/${counted} accents sit outside L 0.66-0.82`);
if (lightOut) fail(`${lightOut}/${counted} light roles sit outside L 0.875-0.98`);
if (bgOut) fail(`${bgOut}/${counted} backgrounds sit outside OKLCh L 0.10-0.18`);
if (accent2Out) fail(`${accent2Out}/${counted} second accents sit outside the accent band, L 0.66-0.82`);
if (accent2Gamut) fail(`${accent2Gamut}/${counted} second accents leave sRGB`);
if (accent2Dull) fail(`${accent2Dull}/${counted} second accents do not carry 0.9 of the accent's chroma share`);
if (accent2Gap) fail(`${accent2Gap}/${counted} second accents are not a scheme's distance (${PARTNER_ANGLES.join(', ')} degrees) from the accent`);
if (accent2Same) fail(`${accent2Same}/${counted} second accents are the accent again`);
if (distinctPairs === 0 || monoPairs === 0) fail(`the sweep held ${distinctPairs} two-hue and ${monoPairs} one-hue pairs; both kinds should appear`);
if (darkOut) fail(`${darkOut}/${counted} dark roles sit outside L 0.36-0.46`);
if (mud) fail(`${mud}/${counted} dark roles are olive or brown`);
if (sd >= 0.04) fail(`accent lightness varies too much across looks (sd ${sd.toFixed(3)})`);
if (ink === 0) fail('no data-raster look appeared in the sweep');
log.push(`${looks} looks over ${ARCHETYPES.length} archetypes: accent L sd ${sd.toFixed(3)}, light above accent in every look, no olive darks, a second accent a scheme's distance away in every look (${distinctPairs} two-hue, ${monoPairs} one-hue; ${ink} ink looks held apart)`);

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
    for (const role of ['bg', 'dark', 'accent', 'light', 'accent2']) {
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
      if (dark.h > 65 && dark.h < 100 && dark.c > 0.03) fail(`turning to ${hue} left an olive dark (hue ${dark.h.toFixed(0)}, chroma ${dark.c.toFixed(3)})`);
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
const ROLES = ['bg', 'dark', 'accent', 'light', 'accent2'];
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

// --- the second accent ----------------------------------------------------
{
  const look = generate('pair-look', 'prism').config.palette;
  if (accentPair(look) !== look.accent2) fail('accentPair did not return the look\'s own second accent');

  // A palette from before the second accent existed gets an analogous partner.
  const old = { bg: look.bg, dark: look.dark, accent: look.accent, light: look.light };
  const base = rgbToOklch(old.accent);
  const sides = new Set();
  for (let k = 0; k < 40; k++) {
    const seed = `pair-seed::${k}`;
    const partner = accentPair(old, seed);
    const o = rgbToOklch(partner);
    const gap = hueGap(o.h, base.h);
    if (Math.abs(gap - 35) > 1.5) fail(`a derived second accent sits ${gap.toFixed(1)} degrees from the accent, expected 35`);
    if (!near(o.l, base.l, 0.012)) fail('a derived second accent changed lightness');
    sides.add(Math.sign(((o.h - base.h + 540) % 360) - 180));
    // Same look, same side, every time.
    if (JSON.stringify(accentPair(old, seed)) !== JSON.stringify(partner)) fail('a look\'s derived second accent changed between calls');
  }
  if (sides.size !== 2) fail('derived second accents all fell on one side of the accent');
  // Never complementary, never the accent itself.
  if (hueGap(rgbToOklch(accentPair(old)).h, base.h) < 20) fail('the default partner is too close to the accent');
  log.push('second accent: a look\'s own is kept; an old look gets an analogous partner, stable per seed, on either side');
}
{
  // The schemes' partner angles, and the sides.
  const expect = { analogous: 35, complementary: 180, triadic: 120, splitComplementary: 150, tetradic: 90, monochrome: 0 };
  for (const [scheme, angle] of Object.entries(expect)) {
    if (SCHEME_PARTNER_DEGREES[scheme] !== angle) fail(`${scheme} partner is ${SCHEME_PARTNER_DEGREES[scheme]} degrees, expected ${angle}`);
  }
  // A monochrome look's second accent keeps the hue and changes the lightness.
  let mono = 0;
  for (let k = 0; k < 400 && mono < 20; k++) {
    const p = generate(`mono-pair::${k}`, 'inkwell').config.palette;
    const a = rgbToOklch(p.accent);
    const a2 = rgbToOklch(p.accent2);
    if (hueGap(a.h, a2.h) > 15) continue;
    mono++;
    if (Math.abs(a2.l - a.l) < 0.05) fail(`a one-hue look's second accent is only ${Math.abs(a2.l - a.l).toFixed(3)} apart in lightness`);
  }
  if (mono === 0) fail('no one-hue look turned up to check');
}
{
  // Fixed palettes carry a designed partner that is not the accent's hue; the
  // rainbow keeps its lightness while the hue travels.
  for (const mode of ['phosphor', 'ice', 'sunset']) {
    const p = resolveEvilandPalette(mode, { bg: [0, 0, 0], dark: [0, 0, 0], accent: [1, 1, 1], light: [1, 1, 1] });
    if (!p.accent2) { fail(`${mode} has no second accent`); continue; }
    if (p.accent2.some((v) => v < 0 || v > 1)) fail(`${mode}'s second accent leaves sRGB`);
    const gap = hueGap(rgbToOklch(p.accent).h, rgbToOklch(p.accent2).h);
    if (gap < 40) fail(`${mode}'s second accent is only ${gap.toFixed(0)} degrees from its accent`);
    if (resolveEvilandPalette(mode, { bg: [0, 0, 0], dark: [0, 0, 0], accent: [1, 1, 1], light: [1, 1, 1] }, 9) !== p) fail(`${mode} is not one fixed palette`);
  }
  const ls = [];
  for (let t = 0; t < 30; t += 1.7) {
    const p = resolveEvilandPalette('rainbow', { bg: [0, 0, 0], dark: [0, 0, 0], accent: [1, 1, 1], light: [1, 1, 1] }, t, 0);
    ls.push(rgbToOklch(p.accent).l, rgbToOklch(p.accent2).l);
    if (hueGap(rgbToOklch(p.accent).h, rgbToOklch(p.accent2).h) < 90) fail('the rainbow\'s second accent is too near its accent');
  }
  if (Math.max(...ls) - Math.min(...ls) > 0.02) fail(`the rainbow's accents change lightness as the hue travels (${Math.min(...ls).toFixed(3)} to ${Math.max(...ls).toFixed(3)})`);
  const hueNow = (t) => rgbToOklch(resolveEvilandPalette('rainbow', { bg: [0, 0, 0], dark: [0, 0, 0], accent: [1, 1, 1], light: [1, 1, 1] }, t, 0).accent).h;
  if (hueGap(hueNow(0), hueNow(5)) < 30) fail('the rainbow\'s hue does not travel');
  log.push('fixed palettes carry a designed second accent; the rainbow holds its lightness while the hue travels');
}

// --- the key turns the palette in OKLCh -----------------------------------
{
  const THEME = { bg: [0.02, 0.02, 0.04], dark: [0.05, 0.3, 0.12], accent: [0.22, 1, 0.35], light: [0.9, 1, 0.92] };
  for (const archetype of ['nebula', 'prism', 'tunnel']) {
    const look = generate(`key-shift::${archetype}`, archetype).config.palette;
    const flat = resolveEvilandPalette('look', THEME, 0, 0, look);
    if (flat !== look) fail('a look with no key shift is not returned as it is');
    const up = resolveEvilandPalette('look', THEME, 0, 1 / 18, look);
    const turn = (rgbToOklch(up.accent).h - rgbToOklch(look.accent).h + 540) % 360 - 180;
    if (Math.abs(turn - 20) > 1.5) fail(`1/18 of a turn moved the accent ${turn.toFixed(1)} degrees, expected 20`);
    if (JSON.stringify(up.bg) !== JSON.stringify(look.bg)) fail('a key shift moved the background');
    if (resolveEvilandPalette('look', THEME, 0, 1 / 18, look) !== up) fail('an unchanged key shift was applied again');
    // A look whose palette is edited in place is re-turned, not served stale.
    const live = JSON.parse(JSON.stringify(look));
    const first = resolveEvilandPalette('look', THEME, 0, 1 / 18, live);
    live.accent2[1] = Math.min(1, live.accent2[1] + 0.2);
    const edited = resolveEvilandPalette('look', THEME, 0, 1 / 18, live);
    if (JSON.stringify(edited.accent2) === JSON.stringify(first.accent2)) fail('a key shift served a stale second accent after the look was edited in place');
    // Five fifths: every role keeps its lightness and gains no chroma.
    const far = resolveEvilandPalette('look', THEME, 0, 5 / 18, look);
    for (const role of ['bg', 'dark', 'accent', 'light', 'accent2']) {
      const before = rgbToOklch(look[role]);
      const after = rgbToOklch(far[role]);
      if (!near(before.l, after.l, 0.012)) fail(`+5 fifths moved ${role} lightness ${before.l.toFixed(3)} -> ${after.l.toFixed(3)}`);
      if (after.c > before.c + 0.01) fail(`+5 fifths added chroma to ${role}`);
    }
    if (hueGap(rgbToOklch(far.accent2).h, rgbToOklch(far.accent).h) < 1 && hueGap(rgbToOklch(look.accent2).h, rgbToOklch(look.accent).h) > 5) fail('a key shift collapsed the pair');
  }
  // Theme mode turns the same way, whatever the cover.
  for (const sleeve of [null, { art: RED_COVER, seed: 'k' }]) {
    const flat = resolveEvilandPalette('theme', THEME, 0, 0, null, sleeve);
    const far = resolveEvilandPalette('theme', THEME, 0, 5 / 18, null, sleeve);
    for (const role of ['dark', 'accent', 'light']) {
      const before = rgbToOklch(flat[role]);
      const after = rgbToOklch(far[role]);
      if (!near(before.l, after.l, 0.012)) fail(`theme +5 fifths moved ${role} lightness`);
      if (after.c > before.c + 0.01) fail(`theme +5 fifths added chroma to ${role}`);
    }
    if (JSON.stringify(far.bg) !== JSON.stringify(flat.bg)) fail('theme key shift moved the background');
    if (hueGap(rgbToOklch(far.accent).h, rgbToOklch(flat.accent).h) < 60) fail('+5 fifths barely turned the theme');
  }
  log.push('key shift turns look and theme palettes in OKLCh: 1/18 turn is 20 degrees, lightness holds, chroma is never added, the cache holds');
}

// --- the section's mood ---------------------------------------------------
{
  const look = generate('mood-look', 'nebula').config.palette;
  if (moodShift(look, 0.5, 1) !== look || moodShift(look, 1, 0) !== look || moodShift(look, 0, 0) !== look) fail('a halfway or unplaced mood changed the palette');
  const dim = moodShift(look, 1, 1);
  const lit = moodShift(look, 0, 1);
  for (const role of ['dark', 'accent', 'light', 'accent2']) {
    const o = rgbToOklch(look[role]);
    const minor = rgbToOklch(dim[role]);
    const major = rgbToOklch(lit[role]);
    if (!(minor.l < o.l - 0.005) || !(minor.c < o.c)) fail(`minor did not darken and grey ${role}`);
    // The light role sits near white, where sRGB leaves little room for chroma: it lifts in lightness only.
    if (!(major.l > o.l - 1e-6) || (role !== 'light' && !(major.c > o.c - 1e-6))) fail(`major did not lift ${role}`);
    if (Math.abs(minor.l - o.l * 0.94) > 0.012) fail(`minor moved ${role} lightness to ${minor.l.toFixed(3)}, expected ${(o.l * 0.94).toFixed(3)}`);
  }
  if (JSON.stringify(dim.bg) !== JSON.stringify(look.bg) || JSON.stringify(lit.bg) !== JSON.stringify(look.bg)) fail('the mood moved the background');
  const turned = (rgbToOklch(dim.accent).h - rgbToOklch(look.accent).h + 540) % 360 - 180;
  if (Math.abs(turned + 6) > 1.5) fail(`minor turned the accent ${turned.toFixed(1)} degrees, expected -6`);
  if (moodShift(look, 1, 1) !== moodShift(look, 1, 1)) fail('an unchanged mood was applied again');
  // Wired in through resolve, after the key.
  const THEME = { bg: [0.02, 0.02, 0.04], dark: [0.05, 0.3, 0.12], accent: [0.22, 1, 0.35], light: [0.9, 1, 0.92] };
  const viaResolve = resolveEvilandPalette('look', THEME, 0, 0, look, null, 1, 1);
  if (JSON.stringify(viaResolve) !== JSON.stringify(dim)) fail('resolveEvilandPalette did not apply the mood');
  if (resolveEvilandPalette('phosphor', THEME, 0, 0, look, null, 1, 1) !== resolveEvilandPalette('phosphor', THEME)) fail('a palette picked by name took a mood');
  // Gamut: the lift never leaves sRGB, however close to the edge the look sits.
  for (let k = 0; k < 200; k++) {
    const p = generate(`mood-gamut::${k}`, ARCHETYPES[k % ARCHETYPES.length]).config.palette;
    for (const m of [moodShift(p, 0, 1), moodShift(p, 1, 1)]) {
      for (const role of ['dark', 'accent', 'light', 'accent2']) if (m[role].some((v) => !(v >= 0 && v <= 1))) fail('the mood left sRGB');
    }
  }
  // The three together: a look following a sleeve, mid-fade, turned by the key,
  // then moodShift. The mood is the last step, so resolve must equal moodShift
  // of the same palette without it, and the mood's own arithmetic still holds.
  let followed = 0;
  for (let k = 0; k < 24; k++) {
    const own = generate(`compose::${k}`, ARCHETYPES[k % ARCHETYPES.length]).config.palette;
    for (const fade of [null, { seed: `compose-to::${k}`, t: 0.4 }]) {
      const sleeve = { art: RED_COVER, seed: `compose-from::${k}`, fade };
      const noMood = resolveEvilandPalette('look', THEME, 0, 5 / 18, own, sleeve, 0, 0);
      const full = resolveEvilandPalette('look', THEME, 0, 5 / 18, own, sleeve, 1, 1);
      if (JSON.stringify(full) !== JSON.stringify(moodShift(noMood, 1, 1))) fail(`look ${k}: sleeve, fade, key and mood did not compose in that order`);
      const plain = resolveEvilandPalette('look', THEME, 0, 5 / 18, own, null, 0, 0);
      if (hueGap(rgbToOklch(noMood.accent).h, rgbToOklch(plain.accent).h) > 5) followed++;
      const a = rgbToOklch(noMood.accent);
      const m = rgbToOklch(full.accent);
      if (Math.abs(m.l - a.l * 0.94) > 0.012) fail(`look ${k}: the mood moved the composed accent to L ${m.l.toFixed(3)}, expected ${(a.l * 0.94).toFixed(3)}`);
      if (Math.abs((m.h - a.h + 540) % 360 - 180 + 6) > 1.5) fail(`look ${k}: the mood turned the composed accent the wrong way`);
      if (JSON.stringify(full.bg) !== JSON.stringify(noMood.bg)) fail(`look ${k}: the mood moved the composed background`);
    }
  }
  if (followed === 0) fail('no look followed the sleeve in the composed case, so it checked nothing');
  log.push('mood: minor lowers lightness 6% and chroma 12% and turns the hue -6 degrees, major lifts; unplaced keys and the halfway point change nothing');
}

// --- the theme palette from a skin ----------------------------------------
{
  const accent = [0.22, 1, 0.35];
  const bg = [0.02, 0.024, 0.04];
  const o = rgbToOklch(accent);
  const p = themePaletteFromAccent(accent, null, bg);
  const light = rgbToOklch(p.light);
  const dark = rgbToOklch(p.dark);
  if (!near(light.l, 0.92, 0.012) || hueGap(light.h, o.h) > 1.5) fail(`theme light is L ${light.l.toFixed(3)} hue ${light.h.toFixed(0)}, expected L 0.92 on the accent's hue ${o.h.toFixed(0)}`);
  if (light.c > maxChroma(0.92, o.h) * 0.5 + 0.004 || light.c < 0.02) fail('theme light does not carry about half the chroma available');
  if (!near(dark.l, 0.4, 0.012)) fail(`theme dark is L ${dark.l.toFixed(3)}, expected 0.40`);
  if (dark.h > 50 && dark.h < 115 && dark.c > 0.03) fail('theme dark landed in the olive band');
  if (JSON.stringify(p.accent) !== JSON.stringify(accent) || JSON.stringify(p.bg) !== JSON.stringify(bg)) fail('the theme palette changed the accent or background');
  if (Math.abs(hueGap(rgbToOklch(p.accent2).h, o.h) - 35) > 1.5) fail('theme second accent is not 35 degrees from the accent');
  // A skin's own dim and light win.
  const own = themePaletteFromAccent(accent, [0.1, 0.4, 0.2], bg, [1, 1, 1]);
  if (JSON.stringify(own.dark) !== JSON.stringify([0.1, 0.4, 0.2]) || JSON.stringify(own.light) !== JSON.stringify([1, 1, 1])) fail('a skin\'s --accent-dim / --viz-light were not kept');
  // A dull skin accent still gives a light that is lighter than the accent.
  for (const a of [[0.1, 0.2, 0.9], [0.9, 0.2, 0.1], [0.8, 0.8, 0.1], [0.5, 0.5, 0.5], [0.05, 0.05, 0.05]]) {
    const q = themePaletteFromAccent(a, null, bg);
    if (!(rgbToOklch(q.light).l > rgbToOklch(q.dark).l + 0.3)) fail(`theme light is not clearly above dark for accent ${a}`);
  }
  log.push('theme palette from a skin accent: light L 0.92 on its hue, dark L 0.40 out of the olive band, analogous second accent');
}

// --- the sleeve, in OKLCh -------------------------------------------------
{
  const size = 32;
  const buffer = (paint) => {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [r, g, b] = paint(x, y);
        const i = (y * size + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      }
    }
    return data;
  };
  const oklch = (rgb) => rgbToOklch(rgb);

  const red = art.analyzePixels(buffer(() => [220, 30, 30]), size);
  if (!red) fail('a solid red cover gave no palette');
  else {
    const o = oklch(red.vibrant);
    if (hueGap(o.h, 29) > 8) fail(`solid red came out at hue ${o.h.toFixed(0)}`);
    if (o.l < 0.615) fail(`solid red came out at L ${o.l.toFixed(3)}, under 0.62`);
    const sec = oklch(red.secondary);
    if (hueGap(sec.h, o.h) < 35) fail('a one-hue cover has no analogous secondary');
    if (!near(sec.l, 0.85, 0.02)) fail(`secondary is L ${sec.l.toFixed(3)}, expected 0.85`);
  }
  if (art.analyzePixels(buffer((x) => [128 + (x % 3), 128, 128]), size) !== null) fail('a grey cover gave a palette');
  if (art.analyzePixels(buffer(() => [250, 250, 250]), size) !== null) fail('a white cover gave a palette');
  if (art.analyzePixels(buffer(() => [4, 4, 6]), size) !== null) fail('a black cover gave a palette');

  // Half blue, half gold: the gold must come out as a second hue well away from the blue.
  const split = art.analyzePixels(buffer((x) => (x < size / 2 ? [30, 60, 220] : [235, 175, 20])), size);
  if (!split) fail('a blue and gold cover gave no palette');
  else {
    const gap = hueGap(oklch(split.vibrant).h, oklch(split.secondary).h);
    if (gap < 50) fail(`the secondary sits ${gap.toFixed(0)} degrees from the vibrant colour, expected at least 50`);
  }

  // A dark navy cover still gives a usable accent on its own hue.
  const navy = art.analyzePixels(buffer(() => [8, 16, 70]), size);
  if (!navy) fail('a dark navy cover gave no palette');
  else {
    const o = oklch(navy.vibrant);
    const want = oklch([8 / 255, 16 / 255, 70 / 255]);
    if (o.l < 0.615) fail(`navy came out at L ${o.l.toFixed(3)}, under 0.62`);
    if (hueGap(o.h, want.h) > 10) fail(`navy came out ${hueGap(o.h, want.h).toFixed(0)} degrees from its own hue`);
    if (o.c < 0.6 * maxChroma(o.l, o.h) - 0.01) fail('navy was not given a usable chroma');
  }

  // A sepia or olive cover is lit into amber, not left at the olive a mid
  // lightness gives, and a one-hue cover there turns its secondary the other
  // way rather than into khaki.
  for (const hue of [60, 75, 90, 105]) {
    const rgb = oklchToRgb(0.5, 0.09, hue).map((v) => Math.round(v * 255));
    const sepia = art.analyzePixels(buffer(() => rgb), size);
    if (!sepia) { fail(`a sepia cover at hue ${hue} gave no palette`); continue; }
    const o = oklch(sepia.vibrant);
    if (o.l < 0.755) fail(`a cover at hue ${hue} came out at L ${o.l.toFixed(3)}, in the olive range`);
    const sec = oklch(sepia.secondary);
    const turn = (sec.h - o.h + 540) % 360 - 180;
    if (turn > -25) fail(`the secondary of a cover at hue ${hue} turned ${turn.toFixed(0)} degrees, expected the other way (-40)`);
    if (sec.h > 50 && sec.h < 115 && sec.c > 0.5 * maxChroma(sec.l, sec.h) + 0.01) fail(`the secondary of a cover at hue ${hue} is a saturated olive`);
  }
  const blueCover = art.analyzePixels(buffer(() => [30, 60, 220]), size);
  if (!blueCover || (oklch(blueCover.secondary).h - oklch(blueCover.vibrant).h + 540) % 360 - 180 < 25) fail('a blue cover\'s secondary no longer turns +40 degrees');

  // A pastel stays a pastel: chroma is capped under the gamut edge.
  const pastel = art.analyzePixels(buffer(() => [240, 190, 200]), size);
  if (pastel) {
    const o = oklch(pastel.vibrant);
    if (o.c > 0.85 * maxChroma(o.l, o.h) + 0.005) fail('a pastel cover was pushed past 0.85 of the available chroma');
  } else fail('a pastel cover gave no palette');

  // Reds that straddle 0 degrees are one hue, not two: half 355 and half 5 degrees beat a lone blue patch.
  const wrap = art.analyzePixels(buffer((x, y) => {
    if (y > 20 && x < 20) return [30, 60, 220];
    return x % 2 ? oklchToRgb(0.6, 0.16, 355).map((v) => Math.round(v * 255)) : oklchToRgb(0.6, 0.16, 5).map((v) => Math.round(v * 255));
  }), size);
  if (!wrap || hueGap(oklch(wrap.vibrant).h, 0) > 15) fail(`a red that straddles 0 degrees lost to a blue patch (got hue ${wrap ? oklch(wrap.vibrant).h.toFixed(0) : 'none'})`);

  // A printed frame is skipped: a green rim round a red cover does not win.
  const framed = art.analyzePixels(buffer((x, y) => (x === 0 || y === 0 || x === size - 1 || y === size - 1 ? [20, 220, 40] : [220, 30, 30])), size);
  if (!framed || hueGap(oklch(framed.vibrant).h, 29) > 8) fail('a one-pixel frame outvoted the cover');

  // The shadow tone and muted colour are still the vibrant hue, dark and quiet.
  if (red && !near(oklch(red.muted).l, 0.38, 0.012)) fail('the cover\'s muted colour is not at L 0.38');
  log.push('sleeve: red -> hue 29, L >= 0.62; olive-band covers lit to amber with the secondary turned away from khaki; grey/white/black -> null; blue and gold -> secondary 50+ degrees away; navy lifted onto its own hue; pastels capped; reds that straddle 0 degrees count once; a frame is skipped');
}
{
  // Blending a theme with a sleeve in OKLCh does not pass through mud.
  const GREEN = { bg: [0.02, 0.02, 0.04], dark: [0.05, 0.3, 0.12], accent: [0.22, 1, 0.35], light: [0.9, 1, 0.92] };
  const cover = { vibrant: oklchToRgb(0.7, 0.2, 29), secondary: oklchToRgb(0.85, 0.1, 280), muted: art.shadowTone(oklchToRgb(0.7, 0.2, 29)) };
  const full = appearance.blendThemeWithSleeve(GREEN, cover);
  const a = rgbToOklch(full.accent);
  const g = rgbToOklch(GREEN.accent);
  const v = rgbToOklch(cover.vibrant);
  const expectL = g.l + (v.l - g.l) * 0.75;
  if (!near(a.l, expectL, 0.02)) fail(`blended accent lightness ${a.l.toFixed(3)}, expected ${expectL.toFixed(3)}`);
  if (a.c < Math.min(g.c, v.c) * 0.6) fail(`blended accent chroma fell to ${a.c.toFixed(3)} on the way between green and red`);
  const dark = rgbToOklch(full.dark);
  const gd = rgbToOklch(GREEN.dark);
  const vd = rgbToOklch(cover.muted);
  if (!near(dark.l, gd.l + (vd.l - gd.l) * 0.6, 0.02)) fail('blended dark did not take 0.6 of the way in lightness');
  const lightRole = rgbToOklch(full.light);
  const gl = rgbToOklch(GREEN.light);
  const vl = rgbToOklch(cover.secondary);
  if (!near(lightRole.l, gl.l + (vl.l - gl.l) * 0.45, 0.02)) fail('blended light did not take 0.45 of the way in lightness');
  if (JSON.stringify(full.bg) !== JSON.stringify(GREEN.bg)) fail('blending changed the background');
  // The second accent goes to the sleeve's second hue, at the blended accent's weight of colour.
  const a2 = rgbToOklch(full.accent2);
  if (!near(a2.l, a.l, 0.02)) fail(`blended second accent L ${a2.l.toFixed(3)} is not the accent's ${a.l.toFixed(3)}`);
  if (hueGap(a2.h, a.h) < 20) fail('blended second accent is on top of the accent');
  const none = appearance.blendThemeWithSleeve(GREEN, null);
  if (none !== GREEN) fail('blending no sleeve changed the theme');
  log.push('sleeve blend: accent 0.75, dark 0.6, light 0.45 in OKLCh without losing chroma; second accent takes the cover\'s second hue');
}
{
  // The look's fade to a following look mixes in OKLCh too: halfway between two
  // saturated looks keeps its chroma.
  const THEME = { bg: [0.02, 0.02, 0.04], dark: [0.05, 0.3, 0.12], accent: [0.22, 1, 0.35], light: [0.9, 1, 0.92] };
  const green = { bg: [0.01, 0.02, 0.01], dark: oklchToRgb(0.4, 0.1, 150), accent: oklchToRgb(0.74, 0.2, 145), light: oklchToRgb(0.93, 0.08, 145), accent2: oklchToRgb(0.74, 0.18, 190) };
  let followSeed = null;
  let freeSeed = null;
  for (let k = 0; k < 60 && (followSeed === null || freeSeed === null); k++) {
    if (hashSeed(`fade::${k}::sleeve`) % 2 === 0) followSeed ??= `fade::${k}`;
    else freeSeed ??= `fade::${k}`;
  }
  const mid = resolveEvilandPalette('look', THEME, 0, 0, green, { art: RED_COVER, seed: freeSeed, fade: { seed: followSeed, t: 0.5 } });
  const m = rgbToOklch(mid.accent);
  if (m.c < 0.1) fail(`a fade toward the cover's hue passed through grey (chroma ${m.c.toFixed(3)})`);
  if (!mid.accent2) fail('a fade between two looks with a second accent dropped it');
  log.push('a look fading toward the sleeve stays saturated halfway');
}
{
  // Old serialised looks carry no second accent: every host derives the same one, and fades are continuous.
  const look = generate('old-look', 'liquid').config.palette;
  const old = { bg: look.bg, dark: look.dark, accent: look.accent, light: look.light };
  const THEME = { bg: [0.02, 0.02, 0.04], dark: [0.05, 0.3, 0.12], accent: [0.22, 1, 0.35], light: [0.9, 1, 0.92] };
  const resolved = resolveEvilandPalette('look', THEME, 0, 0.05, old);
  if (resolved.accent2) fail('resolve invented a second accent for an old look; consumers derive it with accentPair');
  const a = accentPair(old, 'old-seed');
  const b = accentPair({ ...old }, 'old-seed');
  if (JSON.stringify(a) !== JSON.stringify(b)) fail('an old look\'s derived second accent is not stable');
  log.push('old looks without a second accent resolve unchanged and derive a stable partner');
}

// --- the conductor's mood cues -----------------------------------------------
{
  const BEAT = 0.5;
  const section = (start, end, label, key) => ({
    start, end, label, tier: 'steady', intensity: 0.5, keyShift: 0, key,
    fingerprint: new Array(24).fill(0.25), build: null,
  });
  const score = {
    v: 2, duration: 80, bpm: 120, beatConfidence: 0.9, downbeat: 0, downbeatConfidence: 0.8,
    beats: Array.from({ length: 160 }, (_, i) => i * BEAT),
    homeKey: { tonic: 0, minor: false, confidence: 1 },
    energy: new Array(160).fill(0.5),
    sections: [
      section(0, 16, 0, { tonic: 0, minor: false, confidence: 0.9 }),
      section(16, 32, 1, { tonic: 9, minor: true, confidence: 0.9 }),
      section(32, 48, 2, { tonic: 9, minor: true, confidence: 0.2 }),
      section(48, 64, 3, { tonic: 0, minor: false, confidence: 0.9 }),
    ],
  };
  const frame = () => ({
    bands: new Float32Array(24), onsets: [], kick: 0.3, bass: 0.3, snare: 0.2, hat: 0.2, vocal: 0.2, energy: 0.2,
    centroid: 0.5, flatness: 0.2, crest: 0.5, rolloff: 0.5, width: 0.3, pan: 0,
    beatPhase: 0.5, beatConfidence: 0.1, bpm: 93, novelty: 0,
    sectionId: 0, sectionChanged: false, sectionReturn: -1, sectionFingerprint: null,
  });
  const conductor = createConductor();
  conductor.setScore(score);
  const trace = [];
  for (let t = 0; t < 60; t += 1 / 60) {
    const f = conductor.conduct(frame(), t, 1000 / 60);
    trace.push({ t, minor: f.score.minor, confidence: f.score.keyConfidence });
  }
  const at = (t) => trace.find((x) => x.t >= t);
  if (at(10).minor !== 0 || !near(at(10).confidence, 0.9, 0.02)) fail(`a major section reads minor ${at(10).minor}, confidence ${at(10).confidence}`);
  const early = at(16.3).minor;
  const mid = at(17.2).minor;
  if (!(early > 0 && early < mid && mid < 0.9)) fail(`minor should be gliding in after the section change (0.3 s ${early.toFixed(2)}, 1.2 s ${mid.toFixed(2)})`);
  if (!near(mid, 1 - Math.exp(-1.7 / 1.2), 0.08)) fail(`minor glides on the key-shift time constant (1.7 s in: ${mid.toFixed(2)})`);
  if (!near(at(26).minor, 1, 0.02)) fail(`minor settled at ${at(26).minor.toFixed(2)}, expected 1`);
  if (at(26).confidence < 0.85) fail('confidence fell inside a section the score is sure of');
  if (at(46).minor > 0.02 || at(46).confidence > 0.02) fail(`a section at confidence 0.2 still reads minor ${at(46).minor.toFixed(2)} / confidence ${at(46).confidence.toFixed(2)}`);
  if (at(60 - 1 / 60 - 0.001) === undefined) fail('trace ended early');
  // A seek snaps to the section's mood instead of gliding from the old one.
  const seeker = createConductor();
  seeker.setScore(score);
  seeker.conduct(frame(), 5, 16);
  const landed = seeker.conduct(frame(), 20, 16).score;
  if (landed.minor !== 1 || !near(landed.keyConfidence, 0.9, 1e-9)) fail(`a seek into a minor section read ${landed.minor}/${landed.keyConfidence}`);
  // No score, no cues.
  const bare = createConductor();
  if (bare.conduct(frame(), 10, 16).score !== undefined) fail('a conductor with no score stamped cues');
  log.push('conductor: minor glides in over about 1.2 s, holds at zero (confidence 0) below the floor, snaps on a seek');
}

// --- the turn carries the second accent ------------------------------------
{
  const base = generate('turn-pair', 'nebula').config.palette;
  const turned = turnPaletteToHue(base, 200);
  if (!turned.accent2) fail('turnPaletteToHue dropped the second accent');
  else {
    const before = rgbToOklch(base.accent2);
    const after = rgbToOklch(turned.accent2);
    const shift = (rgbToOklch(turned.accent).h - rgbToOklch(base.accent).h + 540) % 360 - 180;
    const moved = (after.h - before.h + 540) % 360 - 180;
    if (hueGap(shift, moved) > 3) fail(`the second accent turned ${moved.toFixed(1)} degrees while the accent turned ${shift.toFixed(1)}`);
    if (!near(after.l, before.l, 0.01)) fail(`turning moved the second accent's lightness (${before.l.toFixed(3)} to ${after.l.toFixed(3)})`);
  }
  const bare = { bg: base.bg, dark: base.dark, accent: base.accent, light: base.light };
  if ('accent2' in turnPaletteToHue(bare, 200)) fail('turning a palette with no second accent invented one');
  log.push('turning a palette turns its second accent with the rest, and leaves a palette without one without');
}

// --- every scene is reachable, by an archetype of its own mood ----------------
{
  const reached = new Map();
  for (const archetype of ARCHETYPES) {
    for (let k = 0; k < 160; k++) {
      const scene = generate(`reach::${archetype}::${k}`, archetype).config.composition?.scene;
      if (!scene) continue;
      if (!reached.has(scene)) reached.set(scene, new Map());
      reached.get(scene).set(archetype, (reached.get(scene).get(archetype) ?? 0) + 1);
    }
  }
  for (const def of SCENES) if (!reached.has(def.id)) fail(`no look ever draws scene ${def.id}`);
  const wired = {
    'caustic-floor': 'liquid', 'thin-film': 'nebula', 'cymatic-plate': 'kaleidoscope', 'ice-halo': 'firefly',
    'ripple-tank': 'echochamber', 'truss-chase': 'strobe', 'gobo-heads': 'pulsar', 'prism-dispersal': 'prism',
    marbling: 'inkwell', 'harmonic-strings': 'phosphor', 'pendulum-wave': 'heartbeat', ferrofluid: 'glasshouse',
    'rose-window': 'cathedral',
  };
  for (const [scene, archetype] of Object.entries(wired)) {
    const n = reached.get(scene)?.get(archetype) ?? 0;
    // Each takes a minority of its host's seeds: the host keeps its own scenes.
    if (n < 160 * 0.15 || n > 160 * 0.6) fail(`${scene} lands on ${n} of 160 ${archetype} seeds, expected between 15% and 60%`);
  }
  // Seeds outside an added share keep the scene they had before it existed:
  // the liquid look still draws liquid-metal on most seeds.
  const liquid = reached.get('liquid-metal')?.get('liquid') ?? 0;
  if (liquid < 160 * 0.4) fail(`liquid draws liquid-metal on only ${liquid} of 160 seeds`);
  log.push(`scenes: all ${SCENES.length} reachable; the thirteen newest each take 15-60% of one archetype's seeds, and the host keeps the rest`);
}

// --- the still scenes hold their field -------------------------------------------
{
  // These scenes draw a finished picture a frame; a look built on one holds the
  // field still, and keeps it still through the mutations the Director applies.
  const still = { 'thin-film': 'nebula', 'ice-halo': 'firefly', 'ripple-tank': 'echochamber', 'gobo-heads': 'pulsar', 'cymatic-plate': 'kaleidoscope', 'truss-chase': 'strobe', 'caustic-floor': 'liquid', 'prism-dispersal': 'prism', marbling: 'inkwell', 'harmonic-strings': 'phosphor', 'pendulum-wave': 'heartbeat', ferrofluid: 'glasshouse', 'rose-window': 'cathedral' };
  let checked = 0;
  for (const [scene, host] of Object.entries(still)) {
    let found = 0;
    for (let k = 0; k < 120 && found < 6; k++) {
      let config = generate(`still::${host}::${k}`, host).config;
      if (config.composition?.scene !== scene) continue;
      found++;
      for (let step = 0; step < 10; step++) {
        config = mutate(config, step % 2 ? 1 : 0.4, `still${k}-${step}`);
        checked++;
        if (config.zoom.base !== 0 || config.rotate.base !== 0 || config.swirl.base > 0.0041) fail(`${scene} moved its field after ${step + 1} mutations (zoom ${config.zoom.base}, rotate ${config.rotate.base}, swirl ${config.swirl.base})`);
        if (config.mirror.base !== 1 || config.mirrorMix.base !== 0) fail(`${scene} folded its field after ${step + 1} mutations`);
        if (config.decay.base < 0.79 - 1e-9 || config.decay.base > 0.93 + 1e-9) fail(`${scene} decay drifted to ${config.decay.base}`);
        if (config.composition.emitters !== 'off' || config.composition.terrain || config.composition.spectrum) fail(`${scene} drew the host's own sources`);
      }
    }
    if (found === 0) fail(`no ${host} seed in 120 drew ${scene}`);
  }
  log.push(`still scenes: the eight newest hold the field through ${checked} mutations`);
}

// --- stereo spread --------------------------------------------------------------
{
  const share = {};
  let outOfRange = 0;
  let narrow = 0;
  let wide = 0;
  const N = 400;
  for (const archetype of ARCHETYPES) {
    let carried = 0;
    for (let k = 0; k < N; k++) {
      const c = generate(`spread::${archetype}::${k}`, archetype).config;
      if (!c.stereoSpread) continue;
      carried++;
      const b = c.stereoSpread.base;
      if (!(b >= 0.55 && b <= 1.45)) outOfRange++;
      if (b < 0.95) narrow++;
      if (b > 1.05) wide++;
    }
    share[archetype] = carried / N;
  }
  if (outOfRange) fail(`${outOfRange} looks carry a stereoSpread base outside 0.55-1.45`);
  if (narrow < 200 || wide < 200) fail(`stereoSpread should both narrow and widen the image (narrow ${narrow}, wide ${wide})`);
  for (const archetype of ['tunnel', 'vortex', 'heartbeat', 'pulsar', 'cathedral', 'phosphor', 'hyperbloom']) {
    if (share[archetype] !== 0) fail(`${archetype} is built on one centred form and must keep the default spread, got ${share[archetype]}`);
  }
  if (!near(share.tidal, 0.7, 0.08)) fail(`tidal carries a spread on ${(share.tidal * 100).toFixed(0)}% of seeds, expected about 70%`);
  if (!near(share.reef, 0.25, 0.08)) fail(`an archetype with no entry carries a spread on ${(share.reef * 100).toFixed(0)}% of seeds, expected about 25%`);
  // Drawn on its own stream: a seed's other channels and its scene are what they
  // were before the spread (and the new scenes) existed. The rows are
  // [archetype, seed, scene, zoom, swirl, decay, rotate] from the last release,
  // taken from seeds that no new scene claims.
  const GOLDEN = [
    ["liquid", 0, "liquid-metal", -0.0087235, 0.0824119, 0.939176, -0.0013679],
    ["liquid", 1, "liquid-metal", -0.0084151, 0.0633096, 0.9087302, 0.0020531],
    ["liquid", 2, "liquid-metal", 0.0057297, 0.0699407, 0.9075229, -0.0004519],
    ["nebula", 0, "volume-garden", 0.0076277, 0.0692418, 0.9144817, -0.0002714],
    ["nebula", 2, "volume-garden", 0.0057076, 0.0202793, 0.9103303, -0.0011965],
    ["nebula", 3, "volume-garden", 0.00494, 0.045134, 0.9339447, -0.0018631],
    ["kaleidoscope", 0, "fractal-zoom", 0.0028832, 0.0678346, 0.8969889, -0.0056631],
    ["kaleidoscope", 2, "fractal-zoom", 0.0013617, 0.065106, 0.9057219, -0.005033],
    ["kaleidoscope", 3, "kaleido-bloom", 0.0019936, 0.0237097, 0.9081115, 0.0013416],
    ["firefly", 0, "constellation", 0.0027024, 0.0118892, 0.9313383, -0.0008217],
    ["firefly", 1, "constellation", 0.0008016, 0.0100872, 0.9448948, 0.0000369],
    ["firefly", 2, "constellation", -0.0015741, 0.0142639, 0.94122, 0.0002019],
    ["echochamber", 0, "comet-trails", 0.0028528, 0.0241452, 0.8713589, 0.0010977],
    ["echochamber", 1, "comet-trails", 0.0013242, 0.0219645, 0.8618304, 0.0001256],
    ["echochamber", 2, "comet-trails", 0.0057055, 0.0515324, 0.8849791, -0.0016118],
    ["strobe", 0, "laser-storm", 0.0088608, 0.0445406, 0.877594, 0.0030795],
    ["strobe", 1, "glitch-bars", 0.0114778, 0.0430832, 0.8756452, -0.0049532],
    ["strobe", 2, "laser-storm", 0.009171, 0.036022, 0.8592509, -0.0043435],
    ["pulsar", 0, "supershape-pulse", 0.0171261, 0.0082514, 0.8582643, -0.0021571],
    ["pulsar", 2, "supershape-pulse", 0.0171366, 0.0138216, 0.8671404, -0.0021071],
    ["pulsar", 3, "supershape-pulse", 0.0111141, 0.0211771, 0.8649352, 0.0023891],
    ["prism", 1, "moire-weave", 0.0086151, 0.0325474, 0.9026366, 0.0010055],
    ["prism", 4, "moire-weave", 0.0087282, 0.0374516, 0.897095, 0.0027067],
    ["prism", 5, "moire-weave", 0.0057811, 0.0582418, 0.8842967, 0.0005159],
    ["tunnel", 0, "tunnel-rings", 0.0265044, 0.0461719, 0.9062948, -0.0031497],
    ["tunnel", 1, "tunnel-rings", 0.0326406, 0.0350116, 0.8808245, -0.0023816],
    ["tunnel", 2, "tunnel-rings", 0.0223584, 0.0576163, 0.9060779, 0.0022242],
    ["reef", 0, "cilia-reef", -0.0000976, 0.0108718, 0.9169751, -0.0001397],
    ["reef", 1, "cilia-reef", 0.0000537, 0.0116295, 0.9268744, 0.000067],
    ["reef", 2, "cilia-reef", -0.0025885, 0.0182416, 0.9051747, -0.0005792],
  ];
  for (const [archetype, k, scene, zoom, swirl, decay, rotate] of GOLDEN) {
    const c = generate(`gold::${archetype}::${k}`, archetype).config;
    if (c.composition?.scene !== scene) fail(`${archetype} seed ${k} draws ${c.composition?.scene}, it drew ${scene}`);
    const got = [c.zoom.base, c.swirl.base, c.decay.base, c.rotate.base];
    got.forEach((v, i) => { if (!near(v, [zoom, swirl, decay, rotate][i], 2e-7)) fail(`${archetype} seed ${k} channel ${['zoom', 'swirl', 'decay', 'rotate'][i]} moved to ${v}, it was ${[zoom, swirl, decay, rotate][i]}`); });
  }
  log.push(`stereoSpread: ${narrow} narrow and ${wide} wide in ${N * ARCHETYPES.length} looks, 0.55-1.45, none on the centred archetypes, tidal ${(share.tidal * 100).toFixed(0)}%`);
}

// --- skins that keep their ink at the top of the ramp ---------------------------
{
  const css = readFileSync(resolve('src/styles/tokens.css'), 'utf8');
  const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
  const lab = (rgb) => { const o = rgbToOklch(rgb); const r = (o.h * Math.PI) / 180; return [o.l, o.c * Math.cos(r), o.c * Math.sin(r)]; };
  const withLight = [];
  let checkedSkins = 0;
  // A skin with a light ink that the accent-built light moves by more than 0.05
  // in OKLab keeps its ink at the top of the ramp; a skin whose ink is dark
  // (the light-surface skins) takes the accent-built light instead.
  for (const m of css.matchAll(/\[data-theme='([a-z]+)'\] \{([^}]*)\}/g)) {
    const [, skin, body] = m;
    const accent = /--accent:\s*(#[0-9a-f]{6})/i.exec(body);
    const ink = /--ink:\s*(#[0-9a-f]{6})/i.exec(body);
    if (!accent || !ink) continue;
    checkedSkins++;
    const sets = /--viz-light:\s*var\(--ink\)/.test(body);
    if (/--viz-light:/.test(body)) withLight.push(skin);
    const built = lab(themePaletteFromAccent(hex(accent[1]), null, [0, 0, 0]).light);
    const inked = lab(hex(ink[1]));
    const delta = Math.hypot(built[0] - inked[0], built[1] - inked[1], built[2] - inked[2]);
    const wants = inked[0] > 0.8 && delta > 0.05;
    if (wants && !sets) fail(`skin ${skin}: its ink is ${delta.toFixed(3)} from the accent-built light in OKLab but --viz-light is not set`);
    if (!wants && sets) fail(`skin ${skin} sets --viz-light but its ink is ${inked[0] < 0.8 ? 'dark' : `only ${delta.toFixed(3)} from the built light`}`);
  }
  if (checkedSkins < 13) fail(`only ${checkedSkins} of the 13 skins parsed`);
  if (!/--viz-light/.test(css.slice(0, css.indexOf("[data-theme='classic']")))) fail('--viz-light is not documented in the root block');
  log.push(`skins: ${checkedSkins} read from tokens.css; --viz-light set on ${withLight.join(', ')}, exactly the light-ink skins the built light would move by more than 0.05 in OKLab`);
}

// --- a key glide has no steps ---------------------------------------------------
{
  // keyShift moves in 1/720-turn steps for a couple of seconds after a modulation.
  // The dark role must not hop as its hue crosses the olive band.
  const lab = (rgb) => { const o = rgbToOklch(rgb); const r = (o.h * Math.PI) / 180; return [o.l, o.c * Math.cos(r), o.c * Math.sin(r)]; };
  let worst = 0;
  let worstAt = '';
  for (let k = 0; k < 24; k++) {
    const look = generate(`glide::${k}`, ARCHETYPES[k % ARCHETYPES.length]).config.palette;
    let prev = null;
    for (let i = 0; i <= 720; i++) {
      const dark = lab(resolveEvilandPalette('look', look, 0, i / 720, look).dark);
      if (prev) {
        const d = Math.hypot(dark[0] - prev[0], dark[1] - prev[1], dark[2] - prev[2]);
        if (d > worst) { worst = d; worstAt = `look ${k}, step ${i}`; }
      }
      prev = dark;
    }
  }
  if (worst > 0.01) fail(`the dark role stepped ${worst.toFixed(4)} in OKLab between two key-shift steps (${worstAt})`);
  // The share itself is continuous and leaves the hues leaveMud moves to alone.
  let jump = 0;
  for (let h = 0; h < 360; h += 0.1) jump = Math.max(jump, Math.abs(appearance.mudChromaShare(h + 0.1) - appearance.mudChromaShare(h)));
  if (jump > 0.05) fail(`mudChromaShare steps ${jump.toFixed(3)} over a tenth of a degree`);
  for (const h of [0, 20, 35, 50, 115, 135, 150, 250, 359]) if (appearance.mudChromaShare(h) !== 1) fail(`mudChromaShare(${h}) is ${appearance.mudChromaShare(h)}; a hue leaveMud produces keeps all its chroma`);
  log.push(`key glide: the dark role's largest step over a full turn of 720 key-shift steps is ${worst.toFixed(4)} OKLab`);
}

// --- the rainbow allocates nothing per frame ---------------------------------------
{
  const theme = { bg: [0, 0, 0], dark: [0, 0, 0], accent: [1, 1, 1], light: [1, 1, 1] };
  const a = resolveEvilandPalette('rainbow', theme, 2, 0);
  if (resolveEvilandPalette('rainbow', theme, 1.995, 0) !== a) fail('the rainbow built a new palette for a hue a sixteenth of a degree away');
  if (resolveEvilandPalette('rainbow', theme, 2 + 1 / 0.035 / 360 * 400, 0) === a) fail('the rainbow returned one palette for a hue a whole turn of the wheel away from itself');
  const wrapped = resolveEvilandPalette('rainbow', theme, 1 / 0.035, 0);
  if (wrapped !== resolveEvilandPalette('rainbow', theme, 2 / 0.035, 0)) fail('the rainbow palette after one turn and after two is not the same one');
  // The dark stays out of the olive core: grey there, not brown.
  for (let t = 0; t < 30; t += 0.25) {
    const d = rgbToOklch(resolveEvilandPalette('rainbow', theme, t, 0).dark);
    if (d.h > 65 && d.h < 100 && d.c > 0.03) fail(`the rainbow's dark is olive at t = ${t} (hue ${d.h.toFixed(0)}, chroma ${d.c.toFixed(3)})`);
  }
  log.push('rainbow: one palette per half degree of hue, shared by every frame that lands on it');
}

// --- a cover that would not read is asked for again while its track plays ----------
{
  const { mock } = await import('node:test');
  const palette = { vibrant: [1, 0, 0], secondary: [1, 1, 1], muted: [0.2, 0.1, 0.1] };
  const flush = () => new Promise((resolveFlush) => setImmediate(resolveFlush));
  // A cover source answering from `answers` in turn, and the clock it is asked on.
  const watch = async (answers, current = () => true, url = 'newart://track/1') => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const asked = [];
    const taken = [];
    art.watchArtPalette(url, current, (p) => taken.push(p), (u) => { asked.push(u); return Promise.resolve(answers[Math.min(asked.length - 1, answers.length - 1)]); });
    await flush();
    const afterFirst = { asked: asked.length, taken: taken.length };
    for (let i = 0; i < 5; i++) {
      mock.timers.tick(31_000);
      await flush();
    }
    mock.timers.reset();
    return { afterFirst, asked: asked.length, taken: taken.length };
  };

  const slowShare = await watch([null, null, palette]);
  if (slowShare.afterFirst.asked !== 1 || slowShare.afterFirst.taken !== 0) fail('a cover that failed at the start of a track was given colours at once');
  if (slowShare.taken !== 1 || slowShare.asked !== 3) fail(`a cover that failed twice and then read gave ${slowShare.taken} palettes after ${slowShare.asked} tries (want 1 after 3)`);
  const never = await watch([null]);
  if (never.asked !== 3 || never.taken !== 0) fail(`a cover that never reads was tried ${never.asked} times (want 3: the first and two more)`);
  const read = await watch([palette]);
  if (read.asked !== 1 || read.taken !== 1) fail(`a cover that read the first time was asked ${read.asked} times`);
  // Still the track playing when the first answer comes in, skipped by the time the retry is due.
  let looks = 0;
  const skipped = await watch([null, palette], () => looks++ === 0);
  if (skipped.taken !== 0 || skipped.asked !== 1) fail(`a track that was skipped after a failed read was asked again (${skipped.asked} tries, ${skipped.taken} palettes)`);
  const none = await watch([palette], () => true, '');
  if (none.asked !== 0) fail('a track with no cover address was asked for');
  log.push('a cover that would not read is tried again twice while its track plays, not after the track changes and not when it read');
}

console.log(log.join('\n'));
console.log(pass ? '[eviland-look-palette-test] PASS' : '[eviland-look-palette-test] FAIL');
process.exitCode = pass ? 0 : 1;
