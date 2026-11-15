// What the frame bus sends the detached window: the palette with its second
// accent, and (when the consumer opts in) an unchanged settled operator only
// when it has changed, at fade time, on attach and at the resend backstop.
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

// Dedup is off by default: every tick carries the operator.
const settled = look();
for (let i = 0; i < 3; i++) frameBus.publish(frame, palette, 16, settled);
if (received.slice(1).some((m) => !m.operator || m.operatorUnchanged)) fail('with dedup off an operator was skipped');

// On: the first goes, identical ones are marked unchanged.
frameBus.setOperatorDedup(true);
received.length = 0;
frameBus.publish(frame, palette, 16, settled);
frameBus.publish(frame, palette, 16, settled);
frameBus.publish(frame, palette, 16, settled);
if (!received[0].operator) fail('the first operator after enabling dedup was not sent');
if (received[1].operator || !received[1].operatorUnchanged || received[2].operator) fail('an unchanged settled operator was re-sent');

// Edited in place: the content differs, so it goes.
settled.palette.accent = [0.1, 0.9, 0.2];
frameBus.publish(frame, palette, 16, settled);
if (!received[3].operator) fail('an operator edited in place was not re-sent');

// A fade always goes, and the first settled look after it goes too.
const fading = { ...look(), _transition: 0.4, _from: look(), _to: look() };
frameBus.publish(frame, palette, 16, fading);
frameBus.publish(frame, palette, 16, fading);
if (!received[4].operator || !received[5].operator) fail('a fade tick was skipped');
frameBus.publish(frame, palette, 16, settled);
if (!received[6].operator) fail('the first settled look after a fade was not sent');

// A new window gets the operator again.
frameBus.publish(frame, palette, 16, settled);
if (received[7].operator) fail('an unchanged operator was sent before any attach');
const second = { ...port, postMessage: (m) => received.push(structuredClone(m)) };
frameBus.attachDetachedPort(second);
frameBus.publish(frame, palette, 16, settled);
if (!received[8].operator) fail('a newly attached window was not given the operator');

// The backstop resends a long-unchanged operator.
let resent = 0;
for (let i = 0; i < 700; i++) {
  const before = received.length;
  frameBus.publish(frame, palette, 16, settled);
  if (received[before].operator) resent++;
}
if (resent < 2) fail(`the backstop resent ${resent} times in 700 ticks`);
log.push(`palette carries accent2; dedup: skipped identical ticks, resent on edit, fade, attach and ${resent}x as the backstop in 700 ticks`);

console.log(log.join('\n'));
console.log(pass ? '[eviland-frame-bus-palette-test] PASS' : '[eviland-frame-bus-palette-test] FAIL');
process.exit(pass ? 0 : 1);
