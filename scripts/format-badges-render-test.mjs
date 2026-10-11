// FormatBadges is what library rows and the Now Playing header actually draw,
// so the codec the scan stored has to reach the classifier through it: an
// .m4a is ALAC or AAC depending on that field alone.
// Run: node scripts/format-badges-render-test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/components/FormatBadges.tsx', import.meta.url))],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) },
  logLevel: 'silent',
});
const mod = { exports: {} };
vm.compileFunction(bundled.outputFiles[0].text, ['module', 'exports', 'require'])(mod, mod.exports, require);
const { FormatBadges } = mod.exports;
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const track = (over) => ({
  path: '/music/song.m4a',
  bitrate: 900_000,
  sampleRate: 44_100,
  duration: 200,
  size: 20_000_000,
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  ...over,
});
const render = (t, props = {}) => renderToStaticMarkup(createElement(FormatBadges, { track: t, ...props }));

// ALAC from the stored codec, in a library row and in the verbose header.
{
  const alac = track({ codec: 'ALAC', codecLossless: true });
  assert.match(render(alac), /data-format-badge-kind="lossless"[^>]*>ALAC</, 'a library row names ALAC and calls it lossless');
  assert.match(render(alac, { density: 'comfortable', verbose: true }), />ALAC</);
  assert.doesNotMatch(render(alac), />M4A</, 'the neutral container chip is for files with no codec on record');
}

// Hi-res ALAC takes the bit depth from the track too.
{
  const hires = track({ codec: 'ALAC', codecLossless: true, sampleRate: 96_000, bitsPerSample: 24 });
  assert.match(render(hires), />24\/96</);
}

// AAC in an .m4a keeps its label and the low-bitrate chip.
{
  const aac = track({ codec: 'MPEG-4/AAC', codecLossless: false, bitrate: 128_000 });
  assert.match(render(aac, { verbose: true }), /data-format-badge-kind="lossy"[^>]*>AAC</);
  assert.match(render(aac), />128</, 'a compact row still flags a low bitrate');
  assert.doesNotMatch(render(aac), />ALAC</);
}

// No codec read yet: the neutral chip in verbose, nothing in a compact row.
{
  const unread = track({});
  assert.match(render(unread, { verbose: true }), /data-format-badge-kind="container"[^>]*>M4A</);
  assert.equal(render(unread), '');
}

console.log('[format-badges-render-test] PASS');
