// The skin editors' colour maths (shared/skin-color.ts): reading a skin value
// into a hex plus alpha for the picker, writing a pick back, the contrast
// readouts, and the whole-skin hue / saturation / brightness transform.
//
// Run: node scripts/skin-color-test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const deadline = setTimeout(() => { console.error('Skin colour test timed out'); process.exit(1); }, 30000);
deadline.unref();

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  stdin: {
    contents: `
      export * from './shared/skin-color';
      export { COLOR_SKIN_VARIABLES, normalizeSkinVariableValue } from './shared/custom-skin';
    `,
    resolveDir: repoRoot,
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

// ── reading a value for the picker ─────────────────────────────────────────
assert.deepEqual(m.parseSkinColor('rgba(10,20,30,0.4)'), { hex: '#0a141e', alpha: 0.4 }, 'rgba keeps its alpha');
assert.deepEqual(m.parseSkinColor('rgba(10, 20, 30, 0.4)'), { hex: '#0a141e', alpha: 0.4 });
assert.deepEqual(m.parseSkinColor('rgb(10 20 30 / 40%)'), { hex: '#0a141e', alpha: 0.4 }, 'the space and slash syntax reads too');
assert.deepEqual(m.parseSkinColor('rgb(10, 20, 30)'), { hex: '#0a141e', alpha: 1 });
assert.deepEqual(m.parseSkinColor('hsl(120, 100%, 25%)'), { hex: '#008000', alpha: 1 }, 'hsl() resolves to a fixed hex');
assert.deepEqual(m.parseSkinColor('hsla(0, 0%, 100%, 0.5)'), { hex: '#ffffff', alpha: 0.5 });
assert.deepEqual(m.parseSkinColor('hsl(0 0% 0% / 50%)'), { hex: '#000000', alpha: 0.5 });
assert.deepEqual(m.parseSkinColor('#0a141e'), { hex: '#0a141e', alpha: 1 });
assert.deepEqual(m.parseSkinColor('#ABC'), { hex: '#aabbcc', alpha: 1 }, 'short hex expands');
assert.deepEqual(m.parseSkinColor('#0a141e80'), { hex: '#0a141e', alpha: 0.502 }, 'hex with alpha digits');
assert.equal(m.parseSkinColor('#abcd').alpha, 0.867);
assert.deepEqual(m.parseSkinColor('transparent'), { hex: '#000000', alpha: 0 });
assert.deepEqual(m.parseSkinColor('rgba(10, 20, 30, 7)'), { hex: '#0a141e', alpha: 1 }, 'alpha is clamped');
for (const junk of ['', '   ', 'nope', 'url(x)', '#12', '#12345', 'rgb(1,2)', 'rgb(a b c)', 'rgba(1,2,3,x)', 'hsl(1)']) {
  assert.equal(m.parseSkinColor(junk), null, `"${junk}" is not a colour`);
}

// Names need the renderer's help, and only plain words are ever sent to it.
const asked = [];
const named = (name) => { asked.push(name); return name === 'teal' ? 'rgb(0, 128, 128)' : name === 'glass' ? 'rgba(1, 2, 3, 0.5)' : null; };
assert.equal(m.parseSkinColor('teal'), null, 'no resolver, no names');
assert.deepEqual(m.parseSkinColor('Teal', named), { hex: '#008080', alpha: 1 });
assert.deepEqual(m.parseSkinColor('glass', named), { hex: '#010203', alpha: 0.5 });
assert.equal(m.parseSkinColor('nosuch', named), null);
asked.length = 0;
m.parseSkinColor('rgb(1,2)', named);
m.parseSkinColor('#12', named);
assert.deepEqual(asked, [], 'a malformed function or hex never reaches the resolver');

// ── writing a pick ─────────────────────────────────────────────────────────
assert.equal(m.pickedSkinColor('#0a141e', 0.4), 'rgba(10, 20, 30, 0.4)');
assert.equal(m.pickedSkinColor('#0a141e', 1), '#0a141e', 'opaque stays a bare hex');
assert.equal(m.pickedSkinColor('#0a141e', 0.456), 'rgba(10, 20, 30, 0.46)', 'alpha to two places');
assert.equal(m.pickedSkinColor('#0a141e', 0), 'rgba(10, 20, 30, 0)');
assert.equal(m.pickedSkinColor('#0a141e', -2), 'rgba(10, 20, 30, 0)');
assert.equal(m.pickedSkinColor('#0a141e', 5), '#0a141e');
assert.equal(m.pickedSkinColor('#0a141e', Number.NaN), '#0a141e');
assert.equal(m.pickedSkinColor('red', 0.5), 'red', 'something that is not a picker hex passes through');
for (const alpha of [0, 0.15, 0.4, 0.55, 0.99, 1]) {
  const text = m.pickedSkinColor('#3a7bd5', alpha);
  assert.ok(m.normalizeSkinVariableValue('--accent', text), `${text} is a value the skin accepts`);
  const back = m.parseSkinColor(text);
  assert.equal(back.hex, '#3a7bd5', `${text} keeps its colour`);
  assert.equal(back.alpha, alpha, `${text} keeps its alpha`);
}

// ── which rows get an alpha slider ─────────────────────────────────────────
assert.equal(m.skinVariableTakesAlpha('--accent-glow', 'rgba(57, 255, 20, 0.55)'), true);
assert.equal(m.skinVariableTakesAlpha('--bevel-dark', '#000000'), true, 'bevels are translucent by nature');
assert.equal(m.skinVariableTakesAlpha('--panel', '#101010'), false, 'a solid surface has no slider');
assert.equal(m.skinVariableTakesAlpha('--panel', 'rgba(16, 16, 16, 0.8)'), true, 'unless the skin already made it translucent');
assert.equal(m.skinVariableTakesAlpha('--radius', '4px'), false, 'lengths have no alpha');

// ── contrast ───────────────────────────────────────────────────────────────
assert.equal(m.contrastBetween('#000000', '#ffffff'), 21);
assert.equal(m.contrastBetween('#ffffff', '#000000'), 21, 'order does not matter');
assert.equal(m.contrastBetween('#336699', '#336699'), 1);
assert.equal(m.contrastBetween('rgba(0, 0, 0, 0.5)', '#ffffff'), null, 'a translucent side is skipped');
assert.equal(m.contrastBetween('#000000', 'nope'), null);
assert.equal(m.contrastBetween('', '#ffffff'), null);
assert.ok(Math.abs(m.contrastBetween('#777777', '#ffffff') - 4.48) < 0.01, '#777 on white is just under AA');
assert.equal(m.formatContrastRatio(21), '21.00:1');
assert.equal(m.formatContrastRatio(4.499), '4.49:1', 'cut, not rounded, so a near miss never looks like a pass');
assert.equal(m.formatContrastRatio(4.5), '4.50:1');

const skin = {
  '--ink': '#e8ecf3', '--ink-2': '#9aa3b2', '--muted': '#4a5160', '--panel': '#11141b', '--bg': '#0a0c10',
  '--display-fg': '#00ff66', '--display-bg': '#0a1408', '--accent': '#7c5cff', '--on-accent': '#000000',
};
const readings = Object.fromEntries(m.skinContrastReadings(skin).map((r) => [r.pair.id, r]));
assert.equal(Object.keys(readings).length, m.SKIN_CONTRAST_PAIRS.length, 'one reading per pair');
assert.equal(readings['ink-panel'].pass, true);
assert.equal(readings['muted-panel'].pass, false, 'a dim muted colour is flagged');
assert.ok(readings['muted-panel'].ratio < 4.5);
assert.equal(readings['accent-panel'].pair.min, 3, 'the accent is held to the lower bar');
assert.equal(readings['accent-panel'].pass, true);
assert.equal(readings['on-accent'].pass, true);
const partial = Object.fromEntries(m.skinContrastReadings({ '--ink': '#fff' }).map((r) => [r.pair.id, r]));
assert.equal(partial['ink-panel'].ratio, null, 'a missing side has no reading');
assert.equal(partial['ink-panel'].pass, null);
const translucent = Object.fromEntries(m.skinContrastReadings({ ...skin, '--panel': 'rgba(17, 20, 27, 0.5)' }).map((r) => [r.pair.id, r]));
assert.equal(translucent['ink-panel'].ratio, null, 'translucent panels are skipped');
assert.equal(translucent['ink-bg'].pass, true, 'pairs without one are still read');

// ── hsl round trip ─────────────────────────────────────────────────────────
for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
  assert.deepEqual(m.hslToRgb(m.rgbToHsl(r, g, b)), [r, g, b], `rgb(${r}, ${g}, ${b}) survives hsl`);
}
assert.deepEqual(m.rgbToHsl(255, 0, 0), { h: 0, s: 1, l: 0.5 });
assert.equal(m.rgbToHex(0, 128.4, 300), '#0080ff');

// ── whole-skin transform ───────────────────────────────────────────────────
const baseline = {
  '--bg': '#0b1014', '--panel': '#11141b', '--panel-2': 'rgba(20, 24, 32, 0.9)', '--line': '#2a3140',
  '--accent': '#ffff00', '--accent-dim': '#b8b800', '--accent-glow': 'rgba(255, 255, 0, 0.55)', '--on-accent': '#000000',
  '--ink': '#e8ecf3', '--muted': '#9aa3b2', '--warn': '#ffb000', '--error': '#ff3d3d',
  '--display-bg': '#0a1408', '--display-fg': '#00ff66', '--radius': '4px',
};
const identity = m.transformSkin(baseline, m.NEUTRAL_TINT);
for (const key of Object.keys(identity)) assert.equal(identity[key], baseline[key], `neutral tint leaves ${key} as it was`);
assert.ok('--accent-glow' in identity && '--on-accent' in identity);
assert.ok(!('--warn' in identity) && !('--error' in identity) && !('--radius' in identity), 'warn, error and lengths are not part of the result');
assert.equal(m.isNeutralTint({ hue: 0, sat: 1, light: 1 }), true);
assert.equal(m.isNeutralTint({ hue: 0, sat: 1, light: 1.01 }), false);

const tints = [
  { hue: 45, sat: 1, light: 1 }, { hue: -90, sat: 0.4, light: 0.7 }, { hue: 180, sat: 1.6, light: 1.4 },
  { hue: 0, sat: 0, light: 1 }, { hue: 359, sat: 1, light: 0 }, { hue: 0, sat: 2, light: 2 },
];
for (const tint of tints) {
  const out = m.transformSkin(baseline, tint);
  for (const [key, value] of Object.entries(out)) {
    assert.ok(m.normalizeSkinVariableValue(key, value), `${key}: ${value} is a value the skin accepts (${JSON.stringify(tint)})`);
  }
  assert.equal(m.parseSkinColor(out['--accent-glow']).alpha, 0.55, 'alpha survives the transform');
  assert.equal(m.parseSkinColor(out['--panel-2']).alpha, 0.9);
  assert.deepEqual(out, m.transformSkin(baseline, tint), 'the same baseline and tint give the same skin');
}

// Computed from the baseline, so dragging there and back wears nothing down.
let walked;
for (const tint of [{ hue: 30, sat: 0.5, light: 0.8 }, { hue: 200, sat: 1.5, light: 1.3 }, { hue: 10, sat: 0.9, light: 1.1 }]) walked = m.transformSkin(baseline, tint);
assert.deepEqual(walked, m.transformSkin(baseline, { hue: 10, sat: 0.9, light: 1.1 }), 'the last position is all that counts');
assert.deepEqual(m.transformSkin(baseline, m.NEUTRAL_TINT), identity, 'back at neutral is the baseline exactly');

const single = (value, tint) => m.transformSkin({ '--accent': value }, tint)['--accent'];
assert.equal(single('#ff0000', { hue: 180, sat: 1, light: 1 }), '#00ffff', 'hue 180 turns red to cyan');
assert.equal(single('#ff0000', { hue: 360, sat: 1, light: 1 }), '#ff0000', 'a full turn is no turn');
assert.equal(single('#ff0000', { hue: -120, sat: 1, light: 1 }), '#0000ff', 'negative hues turn the other way');
assert.equal(single('#808080', { hue: 90, sat: 1, light: 1 }), '#808080', 'a grey has no hue to turn');
assert.equal(single('#ff0000', { hue: 0, sat: 0, light: 1 }), '#808080', 'no saturation is grey at the same lightness');
assert.equal(single('#ff0000', { hue: 0, sat: 1, light: 0 }), '#000000');
assert.equal(single('#ff0000', { hue: 0, sat: 1, light: 2 }), '#ffffff', 'brightness 2 is white');
assert.equal(single('#ff0000', { hue: 0, sat: 1, light: 1.5 }), '#ff8080', 'brightness above 1 goes that share of the way to white');
assert.equal(single('#ff0000', { hue: 0, sat: 1, light: 0.5 }), '#800000', 'below 1 darkens in proportion');
assert.equal(single('#ff0000', { hue: 0, sat: 5, light: 1 }), '#ff0000', 'saturation stops at full');
assert.equal(single('rgba(255, 0, 0, 0.3)', { hue: 180, sat: 1, light: 1 }), 'rgba(0, 255, 255, 0.3)');
assert.equal(m.transformSkin({ '--accent': 'teal' }, { hue: 90, sat: 1, light: 1 })['--accent'], undefined, 'a name with no resolver is left alone');
assert.equal(
  m.transformSkin({ '--accent': 'teal' }, { hue: 180, sat: 1, light: 1 }, { resolveNamed: named })['--accent'],
  m.pickedSkinColor(m.rgbToHex(...m.hslToRgb({ ...m.rgbToHsl(0, 128, 128), h: (m.rgbToHsl(0, 128, 128).h + 180) % 360 })), 1),
  'with a resolver a name is re-tinted',
);

// keep: the default holds warn and error back; an explicit list replaces it.
const turned = m.transformSkin(baseline, { hue: 120, sat: 1, light: 1 });
assert.ok(!('--warn' in turned) && !('--error' in turned));
const all = m.transformSkin(baseline, { hue: 120, sat: 1, light: 1 }, { keep: [] });
assert.ok('--warn' in all && all['--warn'] !== baseline['--warn'], 'with nothing kept warn turns too');
const kept = m.transformSkin(baseline, { hue: 120, sat: 1, light: 1 }, { keep: ['--accent'] });
assert.ok(!('--accent' in kept) && !('--on-accent' in kept), 'a kept accent takes its label with it');

// The label follows the accent while it was the automatic black or white.
const dark = m.transformSkin(baseline, { hue: 0, sat: 1, light: 0.2 });
assert.equal(baseline['--on-accent'], '#000000');
assert.equal(dark['--on-accent'], '#ffffff', 'a dark accent flips the automatic label to white');
const bright = m.transformSkin({ ...baseline, '--accent': '#102040', '--on-accent': '#ffffff' }, { hue: 0, sat: 1, light: 1.9 });
assert.equal(bright['--on-accent'], '#000000', 'and back to black on a light one');
const picked = m.transformSkin({ ...baseline, '--on-accent': '#123456' }, { hue: 0, sat: 1, light: 0.2 });
assert.ok(!('--on-accent' in picked), 'a label the author chose is not re-derived');
const spelled = m.transformSkin({ ...baseline, '--on-accent': 'rgb(0, 0, 0)' }, { hue: 0, sat: 1, light: 0.2 });
assert.equal(spelled['--on-accent'], '#ffffff', 'the automatic label counts however it is spelled');
for (const tint of tints) {
  const out = m.transformSkin(baseline, tint);
  if (!out['--on-accent']) continue;
  assert.ok(m.contrastBetween(out['--on-accent'], out['--accent']) >= 4.5, `the label reads on the accent (${JSON.stringify(tint)})`);
}

// ── the label that follows an accent ───────────────────────────────────────
{
  const names = (name) => ({ teal: 'rgb(0, 128, 128)', navy: 'rgb(0, 0, 128)', yellow: 'rgb(255, 255, 0)' }[name] ?? null);
  assert.equal(m.autoLabelFor('#ffff00'), '#000000', 'black on a light accent');
  assert.equal(m.autoLabelFor('#102040'), '#ffffff', 'white on a dark one');
  assert.equal(m.autoLabelFor('rgba(16, 32, 64, 0.5)'), '#ffffff', 'alpha is ignored; the channels decide');
  assert.equal(m.autoLabelFor('navy'), null, 'a name needs the resolver');
  assert.equal(m.autoLabelFor('navy', names), '#ffffff');
  assert.equal(m.autoLabelFor('not a colour'), null);

  // Leaving a light accent for a dark one takes the automatic black along.
  assert.equal(m.followAccentLabel('#000000', '#ffff00', '#7a3dc8'), '#ffffff');
  assert.equal(m.followAccentLabel('rgb(0, 0, 0)', '#ffff00', '#7a3dc8'), '#ffffff', 'however the label is spelled');
  assert.equal(m.followAccentLabel('#ffffff', '#102040', '#ffee88'), '#000000', 'and the other way');
  assert.equal(m.followAccentLabel('black', 'yellow', 'navy', names), null, 'a name that does not resolve stays put');
  assert.equal(m.followAccentLabel('#000000', 'yellow', 'navy', (name) => (name === 'black' ? 'rgb(0, 0, 0)' : names(name))), '#ffffff', 'names resolve through the hook');
  // A label somebody picked is theirs.
  assert.equal(m.followAccentLabel('#123456', '#ffff00', '#7a3dc8'), null);
  assert.equal(m.followAccentLabel('#ffffff', '#ffff00', '#7a3dc8'), null, 'white on yellow was a choice, not the automatic one');
  assert.equal(m.followAccentLabel(undefined, '#ffff00', '#7a3dc8'), null);
  assert.equal(m.followAccentLabel('#000000', undefined, '#7a3dc8'), null);
  assert.equal(m.followAccentLabel('#000000', '#ffff00', 'nonsense'), null, 'nothing to follow to');
  for (const accent of ['#7a3dc8', '#b03060', '#1f6f50', '#8844cc', '#ffee00', '#102040']) {
    const next = m.followAccentLabel('#000000', '#ffff00', accent);
    assert.ok(m.contrastBetween(next, accent) >= 4.5, `the label reads on ${accent}`);
  }
}

console.log(JSON.stringify({ ok: true }, null, 2));
