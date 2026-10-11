// The volume controls' markup and wiring: the slider announces a static name
// with its value in aria-valuetext, the wheel on every control goes through the
// shared handler with its own source, and the transport's love button is a
// real toggle that stays mounted. Source checks for the parts that need a
// browser to run (effects, Electron-only wheel routing); the slider's markup
// is rendered.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Render VolumeSlider on the server. The player store behind the default wheel
// handler is replaced with a stub: nothing here fires a wheel event.
const stubPlayerWheel = {
  name: 'stub-player-wheel',
  setup(b) {
    b.onResolve({ filter: /player-wheel$/ }, () => ({ path: 'player-wheel', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const handlePlayerWheel = () => {};',
      loader: 'js',
    }));
  },
};
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/components/VolumeSlider.tsx', import.meta.url))],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  plugins: [stubPlayerWheel],
  logLevel: 'silent',
});
const sliderModule = { exports: {} };
vm.compileFunction(bundled.outputFiles[0].text, ['module', 'exports', 'require'])(sliderModule, sliderModule.exports, require);
const { VolumeSlider, volumeLabel } = sliderModule.exports;
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const render = (props) => renderToStaticMarkup(createElement(VolumeSlider, { onChange: () => {}, ...props }));

{
  const half = render({ value: 0.5 });
  assert.match(half, /aria-label="Volume"/, 'the slider has a fixed name');
  assert.match(half, /aria-valuetext="50%"/, 'the value is announced as a percentage');
  const boosted = render({ value: 1.25 });
  assert.match(boosted, /aria-label="Volume"/, 'the name does not change with the value');
  assert.ok(boosted.includes(`aria-valuetext="${volumeLabel(1.25)}"`), 'a boosted volume reads with its dB');
  assert.match(volumeLabel(1.25), /^125% · \+1\.9 dB$/);
  assert.doesNotMatch(boosted, /aria-label="[^"]*\d/, 'no number in the accessible name');
  assert.match(render({ value: 9 }), /aria-valuetext="200% · \+6\.0 dB"/, 'out-of-range values are clamped before they are announced');
}

// The slider's wheel goes to the player by default and to `wheel` when given.
{
  const slider = read('src/components/VolumeSlider.tsx');
  assert.match(slider, /wheel\?: VolumeAccess/, 'the wheel target is a prop');
  assert.match(slider, /handleVolumeWheel\(event, 'slider', access\)/, 'a given target gets the wheel');
  assert.match(slider, /handlePlayerWheel\(event, 'slider'\)/, 'the player gets it otherwise');
  assert.match(slider, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/, 'the listener can stop the page scrolling');
}

// The other wheel call sites, each under its own source.
{
  const deck = read('src/components/decks/RetroTvDeck.tsx');
  assert.match(deck, /handlePlayerWheel\(event, 'knob'\)/, 'the Retro TV knob is the knob source');
  assert.match(deck, /knobRef\.current[\s\S]{0,400}addEventListener\('wheel', onWheel, \{ passive: false \}\)/, 'the knob listener is native and non-passive');
  const viz = read('src/components/FullscreenVisualizer.tsx');
  assert.match(viz, /handlePlayerWheel\([^)]*'fullscreen-meter'[^)]*'fullscreen'\)/, 'the hover meter is told apart from the rest of the fullscreen view');
  assert.match(viz, /root\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/, 'the fullscreen listener is non-passive');
  const player = read('src/lib/player-wheel.ts');
  assert.match(player, /usePlayerStore\.getState\(\)\.volume/, 'the player handler reads the live volume');
}

// The transport's love button is a toggle that outlives the click.
{
  const transport = read('src/components/Transport.tsx');
  assert.match(transport, /aria-pressed=\{!!current\.loved\}/, 'pressed state follows the track');
  assert.doesNotMatch(transport, /aria-pressed="true"/, 'it is not always pressed');
  assert.doesNotMatch(transport, /current\.loved \? \(\s*<button/, 'unloving does not unmount the button');
  assert.match(transport, /current\.id > 0 \? \(\s*<button/, 'only library tracks can be loved');
  assert.match(transport, /void toggleLove\(current\.id\)/, 'clicking toggles');
  assert.match(transport, /<LoveHeart filled=\{!!current\.loved\} \/>/, 'the heart fills when loved');
}

console.log('PASS volume controls: static slider name, live value text, wheel wiring per control, love toggle stays mounted');
