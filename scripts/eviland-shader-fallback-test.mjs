// 10 visualizer modes are shader (WebGL)-driven (isShaderVisualizerMode). If
// startShaderVisualizer() fails (WebGL2/EXT_color_buffer_float unavailable),
// execution falls through to the canvas-2D frame() if/else-if chain. Only 5
// of the 10 shader modes had a matching 2D branch there (aurora, neon-waves,
// neon-ribbons, plasma-grid, burning-cloud); the other 5 (kaleido-bloom,
// liquid-aurora-storm, fractal-pulse, starfield-warp, spectral-tunnel) had no
// branch and the chain had no final else, so those modes just stayed blank
// forever with the rAF loop still spinning. This can only run for real
// inside a browser (canvas/WebGL), so it's verified against source.
// Run: node scripts/eviland-shader-fallback-test.mjs
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = true;
const log = [];
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const source = readFileSync(resolve('src/components/Visualizer.tsx'), 'utf8');

const SHADER_MODES = [
  'aurora', 'neon-waves', 'neon-ribbons', 'plasma-grid', 'burning-cloud',
  'kaleido-bloom', 'liquid-aurora-storm', 'fractal-pulse', 'starfield-warp', 'spectral-tunnel',
];
const HAS_OWN_2D_BRANCH = new Set(['aurora', 'neon-waves', 'neon-ribbons', 'plasma-grid', 'burning-cloud']);

for (const mode of SHADER_MODES) {
  // Only the frame() dispatch chain's own "} else if (mode === 'x') {"
  // branches count — isShaderVisualizerMode's boolean-OR list (checked
  // separately below) also contains "mode === 'x'" for every shader mode,
  // which isn't what this test is asking about.
  const hasBranch = new RegExp(`else if \\(mode === '${mode}'\\) \\{`).test(source);
  if (HAS_OWN_2D_BRANCH.has(mode) && !hasBranch) {
    fail(`${mode} should still have its own 2D fallback branch (regression check)`);
  }
  if (!HAS_OWN_2D_BRANCH.has(mode) && hasBranch) {
    // Not necessarily wrong (a future change could add a real 2D branch for
    // one of these), but it means this test's "5 unhandled modes" premise no
    // longer matches the code and should be revisited.
    fail(`${mode} unexpectedly has its own mode === branch now — update HAS_OWN_2D_BRANCH in this test if a real 2D implementation was added`);
  }
}

// The fix: a final else on the canvas-2D mode chain that paints something
// instead of leaving the canvas blank for whichever mode reached here
// unhandled — the 5 modes above are exactly the case this covers.
const frameBody = source.match(/mode === 'burning-cloud'\) \{[\s\S]*?\n {6}\} else \{[\s\S]*?paintMilkdropFallback\(c, engine\);[\s\S]*?\n {6}\}/);
if (!frameBody) {
  fail('the canvas-2D mode if/else chain should end with a catch-all else that paints a fallback instead of leaving unmatched modes blank');
}

const packageSource = readFileSync(resolve('package.json'), 'utf8');
if (!/"test:eviland-shader-fallback"/.test(packageSource)) fail('package.json should expose the eviland shader fallback test');

console.log(log.join('\n') + '\n' + (pass ? '[shader-fallback-test] PASS' : '[shader-fallback-test] FAIL'));
process.exitCode = pass ? 0 : 1;
