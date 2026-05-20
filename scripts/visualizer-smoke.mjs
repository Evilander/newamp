import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.window = globalThis.window ?? globalThis;

const [butterchurnModule, presetsModule] = await Promise.all([
  import('butterchurn'),
  import('butterchurn-presets'),
]);

const butterchurn = unwrapDefault(butterchurnModule);
const presetApi = unwrapDefault(presetsModule);

assert.equal(typeof butterchurn.createVisualizer, 'function', 'butterchurn.createVisualizer is missing');
assert.equal(typeof presetApi.getPresets, 'function', 'butterchurn-presets.getPresets is missing');

const presets = presetApi.getPresets();
const presetCount = Object.keys(presets).length;
assert.ok(presetCount >= 100, `expected at least 100 Milkdrop presets, got ${presetCount}`);

const visualizerSource = await readFile(new URL('../src/components/Visualizer.tsx', import.meta.url), 'utf8');
const nowPlayingSource = await readFile(new URL('../src/components/views/NowPlayingView.tsx', import.meta.url), 'utf8');
const engineSource = await readFile(new URL('../src/audio/engine.ts', import.meta.url), 'utf8');
const typesSource = await readFile(new URL('../shared/types.ts', import.meta.url), 'utf8');
assert.match(visualizerSource, /mode === 'butterchurn'/, 'Visualizer must implement Butterchurn mode');
assert.match(
  visualizerSource,
  /connectAudio\(engine\.visualizerNode\)/,
  'Butterchurn must connect to the pre-volume Newamp visualizer node',
);
assert.match(engineSource, /get visualizerNode\(\): AudioNode/, 'audio engine should expose a dedicated visualizer node');
assert.match(engineSource, /limiter\.connect\(analyser\)[\s\S]*analyser\.connect\(masterGain\)[\s\S]*masterGain\.connect\(ctx\.destination\)/, 'visualizers should see pre-volume audio so low listening volume remains reactive');
assert.match(engineSource, /smoothingTimeConstant = 0\.24/, 'analyser smoothing should favor responsive visual motion');
assert.match(engineSource, /minDecibels = -86/, 'analyser should expose quieter passages to the visualizer');

const fullscreenSource = await readFile(
  new URL('../src/components/FullscreenVisualizer.tsx', import.meta.url),
  'utf8',
);
assert.match(fullscreenSource, /id: 'butterchurn'/, 'Fullscreen visualizer must expose a Butterchurn preset');
assert.match(fullscreenSource, /id: 'radial'/, 'Fullscreen visualizer must expose Radial preset');
assert.match(fullscreenSource, /id: 'tunnel'/, 'Fullscreen visualizer must expose Tunnel preset');
assert.match(fullscreenSource, /id: 'pulse'/, 'Fullscreen visualizer must expose Pulse preset');
assert.match(fullscreenSource, /id: 'orbital-rings'/, 'Fullscreen visualizer must expose Orbital Rings preset');
assert.match(visualizerSource, /mode === 'orbital-rings'/, 'Visualizer must implement the Orbital Rings preset');
assert.match(fullscreenSource, /id: 'neon-waves'/, 'Fullscreen visualizer must expose Neon Waves preset');
assert.match(fullscreenSource, /id: 'neon-ribbons'/, 'Fullscreen visualizer must expose Neon Ribbons preset');
assert.match(fullscreenSource, /id: 'plasma-grid'/, 'Fullscreen visualizer must expose Plasma Grid preset');
assert.match(fullscreenSource, /id: 'prism-bars'/, 'Fullscreen visualizer must expose Prism Bars preset');
assert.match(fullscreenSource, /id: 'confetti'/, 'Fullscreen visualizer must expose Confetti preset');
assert.match(fullscreenSource, /id: 'burning-cloud'/, 'Fullscreen visualizer must expose Burning Cloud preset');
assert.match(fullscreenSource, /id: 'album-breathe'/, 'Fullscreen visualizer must expose the quiet album-cover breathing preset');
assert.match(typesSource, /'album-breathe'/, 'visualizer preset type should include album-breathe');
assert.match(typesSource, /'tempo-pulse'/, 'visualizer preset type should include Tempo Pulse');
assert.match(typesSource, /'lattice-strobe'/, 'visualizer preset type should include Lattice Strobe');
assert.match(typesSource, /'liquid-mercury'/, 'visualizer preset type should include Liquid Mercury (new in 1.5.2)');
assert.match(fullscreenSource, /id: 'liquid-mercury'/, 'Fullscreen visualizer must expose Liquid Mercury preset');
assert.match(visualizerSource, /mode === 'liquid-mercury'/, 'Visualizer must implement the Liquid Mercury preset');
assert.match(fullscreenSource, /data-newamp-viz-quality-button/, 'Fullscreen visualizer should expose a 4K quality toggle');
assert.match(fullscreenSource, /data-newamp-viz-screen-button/, 'Fullscreen visualizer should expose native screen takeover');
assert.match(fullscreenSource, /data-newamp-viz-palette-button/, 'Fullscreen visualizer should expose visualizer color palette controls');
assert.match(fullscreenSource, /data-newamp-viz-nav-button/, 'Fullscreen visualizer should let users hide top navigation');
assert.match(fullscreenSource, /data-newamp-viz-performance-button/, 'Fullscreen visualizer should expose a low-end performance mode');
assert.match(fullscreenSource, /data-newamp-viz-reactivity-button/, 'Fullscreen visualizer should expose reactivity accuracy controls');
assert.match(fullscreenSource, /data-newamp-viz-auto-vj-button/, 'Fullscreen visualizer should expose an automatic visualizer DJ mode');
assert.match(fullscreenSource, /data-newamp-viz-show-toolbar/, 'Fullscreen visualizer should provide a recovery control when top navigation is hidden');
assert.match(fullscreenSource, /data-newamp-viz-hover-meter/, 'Fullscreen visualizer should expose hover-only volume meter chrome');
assert.match(fullscreenSource, /data-newamp-viz-level-meter-bar/, 'Fullscreen visualizer meter should expose an analyzer-driven level bar');
assert.match(fullscreenSource, /engine\.getTimeData/, 'Fullscreen visualizer meter should read audio analyzer time data, not only the volume setting');
assert.match(fullscreenSource, /data-newamp-album-breathe-visualizer/, 'Album breathe visualizer should be a real full-screen mode');
assert.match(fullscreenSource, /ART PULSE/, 'Fullscreen visualizer should expose random album-art pulse mode');
assert.match(fullscreenSource, /ArrowRight/, 'Fullscreen visualizer should support keyboard preset cycling');
assert.match(fullscreenSource, /pickAutoVjPreset/, 'Auto VJ should choose presets from live audio energy');
assert.match(fullscreenSource, /visualizerEnergy/, 'Auto VJ should inspect analyzer bins instead of cycling blindly');
assert.match(fullscreenSource, /VIZ_AUTO_VJ_KEY/, 'Auto VJ should persist between visualizer sessions');
assert.match(visualizerSource, /boostFrequencyData\(freq, reactivity\)/, 'Visualizer should expose configurable signal response');
assert.match(visualizerSource, /type VizPalette/, 'Visualizer should support user-selectable color palettes');
assert.match(visualizerSource, /type VizPerformance/, 'Visualizer should support a low-end rendering mode');
assert.match(visualizerSource, /type VizReactivity/, 'Visualizer should support truthful and boosted reactivity modes');
assert.match(visualizerSource, /startShaderVisualizer/, 'Heavy fullscreen visualizer presets should use the GPU shader path');
assert.match(visualizerSource, /u_beat/, 'Shader visualizers should receive beat-reactive audio features');
assert.match(visualizerSource, /u_bands0/, 'Shader visualizers should receive reduced FFT band uniforms');
assert.match(visualizerSource, /oscilloscopePalette/, 'Oscilloscope should support selectable and changing colors');
assert.match(
  visualizerSource,
  /quality === '4k' \? 4_200_000 : 2_100_000/,
  'Fullscreen visualizer should cap render pixels for responsive full-screen playback',
);
assert.match(
  visualizerSource,
  /quality === '4k' \? 1000 \/ 30 : 1000 \/ 45/,
  'Fullscreen visualizer should throttle paint rate enough to stay clickable',
);
assert.match(visualizerSource, /1_050_000/, 'Low-end visualizer mode should cap render pixels for older GPUs');
assert.match(
  fullscreenSource,
  /data-newamp-fullscreen-visualizer/,
  'Fullscreen visualizer must expose a stable UI smoke selector',
);
assert.match(
  visualizerSource,
  /data-newamp-visualizer-canvas/,
  'Visualizer canvas must expose a stable UI smoke selector',
);
assert.match(
  visualizerSource,
  /1000 \/ 30/,
  'Embedded visualizers must be capped below fullscreen frame rate',
);
assert.match(
  visualizerSource,
  /document\.hidden/,
  'Visualizers must pause painting while the app is hidden',
);
assert.match(
  visualizerSource,
  /isConnected/,
  'Visualizers must skip detached canvases',
);
assert.match(
  visualizerSource,
  /clientWidth <= 0 \|\| node\.clientHeight <= 0/,
  'Visualizers must skip zero-size canvases',
);
assert.match(
  nowPlayingSource,
  /data-newamp-spectrum-style-picker/,
  'Now Playing should expose multiple spectrum display choices',
);
assert.doesNotMatch(visualizerSource, /fillText\(['"]Milkdrop/i, 'Milkdrop fallback should remain visual instead of showing an unavailable error label');

const packageSource = await readFile(new URL('../package.json', import.meta.url), 'utf8');
assert.match(packageSource, /"smoke:ui-visualizer"/, 'package.json must expose the UI visualizer smoke');

const releaseGateSource = await readFile(new URL('./release-gate.mjs', import.meta.url), 'utf8');
assert.match(releaseGateSource, /'smoke:ui-visualizer'/, 'release gate must run the UI visualizer smoke');

console.log(
  JSON.stringify(
    {
      butterchurn: true,
      presetCount,
      fullscreenMode: true,
      uiSmoke: true,
    },
    null,
    2,
  ),
);

function unwrapDefault(module) {
  const first = module.default ?? module;
  return first.default ?? first;
}
