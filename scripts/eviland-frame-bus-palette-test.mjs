// What the frame bus sends the detached window: the palette with its second
// accent, and the look it renders with on every tick (the projector keeps no
// look of its own, so a tick without one would drop it).
// Run: node scripts/eviland-frame-bus-palette-test.mjs
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const outfile = resolve('tmp/eviland-v2-bus-bundle.mjs');
await build({ entryPoints: [resolve('src/visualizer/frame-bus.ts')], bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile, logLevel: 'silent' });
const { frameBus } = await import(pathToFileURL(outfile).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const received = [];
const port = { onmessage: null, onmessageerror: null, start() {}, close() {}, postMessage: (m) => received.push(structuredClone(m)) };
frameBus.attachDetachedPort(port);
const frame = { bands: new Float32Array(24), onsets: [], energy: 0.5 };
const palette = { bg: [0, 0, 0], dark: [0.1, 0.1, 0.3], accent: [0.9, 0.5, 0.1], light: [1, 1, 1], accent2: [0.2, 0.8, 0.9] };
const look = () => ({ version: 1, seed: 'a', palette: { ...palette }, zoom: { base: 1 } });

// The palette crosses with its second accent.
frameBus.publish(frame, palette, 16, look());
if (JSON.stringify(received[0]?.palette?.accent2) !== JSON.stringify(palette.accent2)) fail('the palette arrived without its second accent');
if (!received[0]?.operator) fail('the first operator was not sent');

// A settled look is sent on every tick, edited in place or not.
const settled = look();
received.length = 0;
for (let i = 0; i < 3; i++) frameBus.publish(frame, palette, 16, settled);
settled.palette.accent = [0.1, 0.9, 0.2];
frameBus.publish(frame, palette, 16, settled);
if (received.length !== 4 || received.some((m) => !m.operator || 'operatorUnchanged' in m)) fail('a tick went without its operator');
if (JSON.stringify(received[3].operator.palette.accent) !== JSON.stringify([0.1, 0.9, 0.2])) fail('an operator edited in place was sent as it was');

// A tick the producer has no look for carries none.
received.length = 0;
frameBus.publish(frame, palette, 16);
if (received[0].operator) fail('a tick without an operator carried one');
log.push('palette carries accent2; every tick carries the operator it was given');

console.log(log.join('\n'));
console.log(pass ? '[eviland-frame-bus-palette-test] PASS' : '[eviland-frame-bus-palette-test] FAIL');
process.exit(pass ? 0 : 1);
