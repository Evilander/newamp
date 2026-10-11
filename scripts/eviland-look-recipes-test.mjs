// What the randomizer makes of a seed: dye only where a look is made of it, a
// waveform where one is drawn, audio wired into every look, seed codes that
// can be pasted back, and the three scenes added after the original set.
// Run: node scripts/eviland-look-recipes-test.mjs
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
const rand = await load('src/visualizer/eviland-randomizer.ts', 'eviland-look-recipes-rand-bundle');
const scenes = await load('src/visualizer/scenes/index.ts', 'eviland-look-recipes-scenes-bundle');
const { rgbToOklch } = await load('src/visualizer/eviland-appearance.ts', 'eviland-look-recipes-appearance-bundle');
const { generate, mutate, decode, ARCHETYPES, audioDrive, AUDIO_DRIVE_FLOOR, randomSeedCode, seedCodeFor } = rand;
const { SCENES } = scenes;

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const SEEDS = 150;
const looks = (archetype, n = SEEDS) => Array.from({ length: n }, (_, k) => generate(`recipe::${archetype}::${k}`, archetype).config);
const hasDye = (config) => config.liquidMix.base > 0 || (config.liquidMix.bindings?.length ?? 0) > 0;
// The most the wave reaches: its base plus every positive audio gain at full scale.
const wavePeak = (config) => config.waveform.intensity.base + (config.waveform.intensity.bindings ?? []).reduce((sum, b) => sum + Math.max(0, b.gain), 0);

// --- dye -----------------------------------------------------------------
// A low liquidMix only darkens the frame and leaves a soft blob on every
// kick. The looks that are made of dye keep it; nothing else has any.
const DYE_LOOKS = new Set(['liquid', 'nebula', 'inkwell', 'tidal', 'glasshouse', 'stormfront', 'emberveil']);
{
  let withDye = 0;
  let total = 0;
  for (const archetype of ARCHETYPES) {
    for (const config of looks(archetype)) {
      total++;
      if (hasDye(config)) {
        withDye++;
        if (!DYE_LOOKS.has(archetype)) fail(`${archetype} has dye (liquidMix base ${config.liquidMix.base})`);
      }
    }
  }
  for (const archetype of DYE_LOOKS) {
    if (!looks(archetype, 40).some(hasDye)) fail(`${archetype} lost its dye`);
  }
  const share = withDye / total;
  if (share > 0.25) fail(`${(share * 100).toFixed(0)}% of looks carry dye`);
  log.push(`dye on ${(share * 100).toFixed(0)}% of ${total} looks, only in ${[...DYE_LOOKS].join(', ')}`);
}
{
  // Mutating a look with no dye must not bring it back.
  for (let k = 0; k < 40; k++) {
    let config = generate(`recipe::dye-mutate::${k}`, k % 2 ? 'prism' : 'echochamber').config;
    for (let step = 0; step < 12; step++) config = mutate(config, 1, `m${k}-${step}`);
    if (hasDye(config)) fail(`a dyeless look grew dye after mutating (seed ${k})`);
  }
  log.push('mutate leaves dyeless looks dyeless');
}

// --- waveform ------------------------------------------------------------
const WAVE_LOOKS = new Set(['wireframe', 'ribbonfall', 'pulsar', 'mosaic', 'supernova', 'phosphor']);
{
  const visible = new Set();
  for (const archetype of ARCHETYPES) {
    for (const config of looks(archetype)) {
      const mode = config.waveform.mode;
      if (mode === 'lissajous') fail(`${archetype} drew a lissajous waveform, which has no renderer`);
      if (mode !== 'off') {
        visible.add(archetype);
        if (!WAVE_LOOKS.has(archetype)) fail(`${archetype} draws a waveform (${mode})`);
        if (archetype !== 'phosphor' && wavePeak(config) > 1.2 + 1e-9) fail(`${archetype} waveform peaks at ${wavePeak(config)}, above 1.2`);
      }
    }
  }
  if (visible.size < 5) fail(`only ${visible.size} archetypes show a waveform`);
  // The cap scales the audio gains with the base; it must not strip them, and
  // the phosphor scope stays exempt.
  const driven = ['wireframe', 'ribbonfall', 'pulsar', 'mosaic', 'supernova'].filter((archetype) =>
    looks(archetype, 60).some((c) => c.waveform.mode !== 'off' && (c.waveform.intensity.bindings?.length ?? 0) > 0));
  if (driven.length < 3) fail(`only ${driven.join(', ') || 'no archetype'} keep audio on the wave intensity`);
  if (!looks('phosphor', 60).some((c) => wavePeak(c) > 1.2 + 1e-9)) fail('the phosphor scope is capped');
  for (const archetype of ['mycelium', 'mitosis', 'medusa', 'reef']) {
    if (looks(archetype, 40).some((c) => c.waveform.mode !== 'off')) fail(`living look ${archetype} draws a waveform`);
  }
  log.push(`waveform visible in ${visible.size} archetypes: ${[...visible].join(', ')}`);
}
{
  // A mutated look keeps the waveform state it had: an off wave stays off,
  // and nothing mutates into lissajous.
  for (let k = 0; k < 40; k++) {
    let config = generate(`recipe::wave-mutate::${k}`, 'medusa').config;
    let drawn = generate(`recipe::wave-mutate::${k}`, 'ribbonfall').config;
    for (let step = 0; step < 15; step++) {
      config = mutate(config, 1, `w${k}-${step}`);
      drawn = mutate(drawn, 1, `x${k}-${step}`);
      if (config.waveform.mode !== 'off') fail('mutate turned a wave on for a look drawn without one');
      if (drawn.waveform.mode === 'lissajous') fail('mutate produced a lissajous waveform');
    }
  }
  log.push('mutate keeps waveform state and never picks lissajous');
}
{
  // The Director mutates every look it makes; the wave's cap has to hold through that.
  let checked = 0;
  for (const archetype of ['wireframe', 'ribbonfall', 'pulsar', 'mosaic', 'supernova']) {
    for (let k = 0; k < 20; k++) {
      let config = generate(`recipe::wave-peak::${archetype}::${k}`, archetype).config;
      for (let step = 0; step < 12; step++) {
        config = mutate(config, step % 2 ? 1 : 0.3, `peak${k}-${step}`);
        checked++;
        if (wavePeak(config) > 1.2 + 1e-9) {
          fail(`${archetype} wave peaks at ${wavePeak(config)} after ${step + 1} mutations`);
          break;
        }
      }
    }
  }
  log.push(`mutate keeps the wave under its cap (${checked} mutations)`);
}

// --- audio drive ---------------------------------------------------------
{
  let lowest = Infinity;
  let seeds = 0;
  for (const archetype of ARCHETYPES) {
    for (const config of looks(archetype)) {
      seeds++;
      lowest = Math.min(lowest, audioDrive(config));
    }
  }
  for (let k = 1; k <= 3000; k++) {
    const config = generate(k).config;
    seeds++;
    lowest = Math.min(lowest, audioDrive(config));
  }
  if (!(lowest >= AUDIO_DRIVE_FLOOR)) fail(`a look has audio drive ${lowest.toFixed(3)}, under the ${AUDIO_DRIVE_FLOOR} floor`);
  const a = JSON.stringify(generate('recipe-drive', 'medusa').config);
  const b = JSON.stringify(generate('recipe-drive', 'medusa').config);
  if (a !== b) fail('generate is not deterministic');
  log.push(`${seeds} looks, none under the audio drive floor (lowest ${lowest.toFixed(3)})`);
}

// --- seed codes ----------------------------------------------------------
{
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const code = randomSeedCode();
    if (!/^[A-Z0-9-]+$/.test(code)) fail(`randomSeedCode gave ${code}`);
    seen.add(code);
    const config = decode(code);
    if (!config) fail(`${code} cannot be pasted back`);
    else if (config.seed !== code) fail(`${code} decodes to a look with code ${config.seed}`);
  }
  if (seen.size < 39) fail(`40 random codes gave ${seen.size} distinct values`);
  for (const seed of ['seed-1', 'seed-3', 'a long phrase with spaces', 42, '1337']) {
    const code = seedCodeFor(seed);
    const config = decode(code);
    if (!config) fail(`seedCodeFor(${JSON.stringify(seed)}) = ${code} cannot be decoded`);
    else if (JSON.stringify(config) !== JSON.stringify(generate(seed).config)) fail(`seedCodeFor(${JSON.stringify(seed)}) decodes to another look`);
    if (code !== generate(seed).seed) fail(`seedCodeFor(${JSON.stringify(seed)}) differs from generate().seed`);
  }
  log.push('random codes are fresh and decode; text seeds turn into codes that decode to the same look');
}

// --- the scenes added after the original set -----------------------------
const ADDED = [
  { archetype: 'tidal', scene: 'spectral-slit', original: 'spectro-rain' },
  { archetype: 'lattice', scene: 'data-raster', original: 'hex-pulse' },
  { archetype: 'deepfield', scene: 'bokeh-field', original: 'deep-jelly' },
];
{
  const ids = new Set(SCENES.map((s) => s.id));
  if (ids.size !== SCENES.length) fail('two scenes share an id');
  for (const { scene, original } of ADDED) {
    if (!ids.has(scene)) fail(`${scene} is not registered`);
    if (!ids.has(original)) fail(`${original} is not registered`);
  }
  for (const [name, mood] of [['Spectral Strata', 'mid'], ['Data Raster', 'high'], ['Bokeh Field', 'calm']]) {
    const def = SCENES.find((s) => s.name === name);
    if (!def) fail(`no scene named ${name}`);
    else if (def.mood !== mood) fail(`${name} has mood ${def.mood}, expected ${mood}`);
  }
  for (const archetype of ARCHETYPES) {
    for (const config of looks(archetype, 60)) {
      const scene = config.composition?.scene;
      if (scene && !ids.has(scene)) fail(`${archetype} names unregistered scene ${scene}`);
      const added = ADDED.find((a) => a.scene === scene);
      if (added && added.archetype !== archetype) fail(`${scene} showed up in ${archetype}`);
    }
  }
  for (const { archetype, scene, original } of ADDED) {
    const found = looks(archetype, 300).map((c) => c.composition.scene);
    const share = found.filter((s) => s === scene).length / found.length;
    const kept = found.filter((s) => s === original).length / found.length;
    if (share < 0.2 || share > 0.8) fail(`${scene} takes ${(share * 100).toFixed(0)}% of ${archetype} looks`);
    if (share + kept !== 1) fail(`${archetype} picked a scene other than ${scene} or ${original}`);
  }
  log.push('Spectral Strata, Data Raster and Bokeh Field are registered and reachable; the other looks keep their scenes');
}
{
  const pick = (archetype, scene) => looks(archetype, 200).filter((c) => c.composition.scene === scene);
  const inRange = (value, min, max) => value >= min - 1e-9 && value <= max + 1e-9;
  const quiet = (config) => {
    for (const key of ['zoom', 'rotate', 'swirl', 'mirrorMix', 'fluid', 'liquidMix']) {
      if (config[key].base !== 0 || (config[key].bindings?.length ?? 0) > 0) return `${key} is not still`;
    }
    return null;
  };
  const strata = pick('tidal', 'spectral-slit');
  if (strata.length === 0) fail('no Spectral Strata look came up');
  for (const c of strata) {
    const reason = quiet(c);
    if (reason) fail(`Spectral Strata: ${reason}`);
    if (!(c.flowX.base < -0.004)) fail(`Spectral Strata flowX ${c.flowX.base} does not scroll the field left`);
    if (c.flowY.base !== 0) fail('Spectral Strata drifts vertically');
    if (!inRange(c.decay.base, 0.955, 0.97)) fail(`Spectral Strata decay ${c.decay.base}`);
    if (c.mirror.base !== 1) fail('Spectral Strata has a mirror fold');
    if (c.composition.emitters !== 'off' || c.composition.terrain || c.composition.spectrum) fail('Spectral Strata draws sources besides the scene');
    if (c.morph?.kind !== 'marble' || !inRange(c.morph.amount.base, 0.01, 0.1)) fail('Spectral Strata morph is not a light marble');
  }
  const raster = pick('lattice', 'data-raster');
  if (raster.length === 0) fail('no Data Raster look came up');
  for (const c of raster) {
    const reason = quiet(c);
    if (reason) fail(`Data Raster: ${reason}`);
    if (!inRange(c.decay.base, 0.78, 0.82)) fail(`Data Raster decay ${c.decay.base}`);
    if (c.bloom.base > 0.02 + 1e-9) fail(`Data Raster bloom base ${c.bloom.base}`);
    if (c.composition.emitters !== 'off') fail('Data Raster has emitters');
    if (c.morph) fail('Data Raster has a morph');
  }
  const bokeh = pick('deepfield', 'bokeh-field');
  if (bokeh.length === 0) fail('no Bokeh Field look came up');
  for (const c of bokeh) {
    if (!inRange(c.decay.base, 0.92, 0.94)) fail(`Bokeh Field decay ${c.decay.base}`);
    if (c.mirror.base !== 1) fail('Bokeh Field has a mirror fold');
    if (hasDye(c)) fail('Bokeh Field has dye');
  }
  log.push(`profiles hold: ${strata.length} strata, ${raster.length} raster, ${bokeh.length} bokeh looks checked`);
}
{
  // The Director runs mutate() on every look it generates (tier amounts of
  // 0.1 to 0.3, a drift target at 0.12), so the designs have to hold through it.
  const inRange = (value, min, max) => value >= min - 1e-9 && value <= max + 1e-9;
  const stays = (c, keys) => keys.filter((key) => c[key].base !== 0 || (c[key].bindings?.length ?? 0) > 0).map((key) => `${key} moves`);
  const STILL = ['zoom', 'rotate', 'swirl', 'mirrorMix', 'fluid', 'liquidMix'];
  const CHECKS = {
    'spectral-slit': (c) => [
      ...stays(c, STILL),
      ...(c.flowX.base < -0.0065 - 1e-9 || c.flowX.base > -0.0045 + 1e-9 ? [`flowX ${c.flowX.base} leaves the scroll`] : []),
      ...(c.flowY.base !== 0 ? ['flowY drifts'] : []),
      ...(inRange(c.decay.base, 0.955, 0.968) ? [] : [`decay ${c.decay.base}`]),
      ...(c.mirror.base !== 1 ? ['mirror folds'] : []),
      ...(c.spinFromSection ? ['the section adds spin'] : []),
    ],
    'data-raster': (c) => [
      ...stays(c, STILL),
      ...(inRange(c.decay.base, 0.78, 0.82) ? [] : [`decay ${c.decay.base}`]),
      ...(c.bloom.base > 0.02 + 1e-9 ? [`bloom ${c.bloom.base}`] : []),
      ...(c.spinFromSection ? ['the section adds spin'] : []),
      ...(c.palette.bg.some((v) => v !== 0) ? [`bg ${c.palette.bg}`] : []),
      ...['dark', 'accent', 'light'].filter((role) => rgbToOklch(c.palette[role]).c > 0.02 + 1e-4).map((role) => `${role} is tinted`),
    ],
    'bokeh-field': (c) => [
      ...(inRange(c.decay.base, 0.92, 0.94) ? [] : [`decay ${c.decay.base}`]),
      ...(inRange(c.zoom.base, 0.003, 0.005) ? [] : [`zoom ${c.zoom.base}`]),
      ...(inRange(c.rotate.base, -0.0004, 0.0004) ? [] : [`rotate ${c.rotate.base}`]),
      ...(c.mirror.base !== 1 || c.mirrorMix.base !== 0 ? ['mirror folds'] : []),
      ...(hasDye(c) ? ['dye'] : []),
    ],
  };
  let mutations = 0;
  let changed = 0;
  for (const [archetype, scene] of [['tidal', 'spectral-slit'], ['lattice', 'data-raster'], ['deepfield', 'bokeh-field']]) {
    const found = looks(archetype, 200).filter((c) => c.composition.scene === scene);
    if (found.length === 0) fail(`no ${scene} look came up`);
    for (const original of found) {
      for (const problem of CHECKS[scene](original)) fail(`${scene} look ${original.seed}: ${problem}`);
      for (const amount of [0.1, 0.3, 1]) {
        let config = original;
        for (let step = 0; step < 6; step++) {
          config = mutate(config, amount, `hold::${original.seed}::${amount}::${step}`);
          mutations++;
          for (const problem of CHECKS[scene](config)) fail(`${scene} look ${original.seed} at ${amount}, step ${step + 1}: ${problem}`);
        }
        if (JSON.stringify(config) !== JSON.stringify(original)) changed++;
      }
    }
  }
  // The checks above must not pass because mutate stopped doing anything.
  if (changed < mutations / 6 * 0.9) fail(`only ${changed} of ${(mutations / 6).toFixed(0)} mutated profile looks differ from the original`);
  log.push(`profile looks hold through ${mutations} mutations (strata still, raster ink untinted, bokeh soft)`);
}
{
  // The scenes' own registry data.
  const solid = ['volume-garden', 'liquid-metal', 'city-pulse', 'cilia-reef', 'smoke-ink'];
  for (const def of SCENES) {
    if (def.occlusion !== undefined && !(def.occlusion >= 0 && def.occlusion <= 1)) fail(`${def.id} occlusion ${def.occlusion} is outside 0..1`);
  }
  for (const id of solid) {
    const def = SCENES.find((s) => s.id === id);
    if (!def || !(def.occlusion >= 0.85)) fail(`${id} should be a solid (occlusion >= 0.85)`);
  }
  log.push('occlusion values are in range and the solid scenes are solid');
}

console.log(log.join('\n'));
console.log(pass ? '[eviland-look-recipes-test] PASS' : '[eviland-look-recipes-test] FAIL');
process.exitCode = pass ? 0 : 1;
