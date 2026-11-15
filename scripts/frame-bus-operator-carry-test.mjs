// The detached consumer keeps the last operator it was sent, so the producer
// can skip an unchanged settled look. Pins the consumer half and the
// producer's skip, resend and fade rules.
// Run: node scripts/frame-bus-operator-carry-test.mjs
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const outfile = resolve('tmp/frame-bus-operator-carry-bundle.mjs');
await build({
  entryPoints: [resolve('src/visualizer/frame-bus.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile, logLevel: 'silent',
});
const { frameBus, createOperatorCarry } = await import(pathToFileURL(outfile).href);

const log = [];
let pass = true;
const check = (ok, message) => { if (!ok) { pass = false; log.push('FAIL: ' + message); } };

// Consumer: replaces on operator, holds on operatorUnchanged, nothing before the first.
const carry = createOperatorCarry();
const a = { version: 1, name: 'a' };
const b = { version: 1, name: 'b' };
check(carry({ operatorUnchanged: true }) === undefined, 'a skipped tick before any operator must resolve to nothing');
check(carry({ operator: a }) === a, 'an operator payload must resolve to itself');
check(carry({ operatorUnchanged: true }) === a, 'a skipped tick must resolve to the held operator');
check(carry({}) === undefined, 'a payload with no opinion must not resolve to the held operator');
check(carry({ operator: b }) === b && carry({ operatorUnchanged: true }) === b, 'a new operator must replace the held one');

// Producer: a fake port records what is posted.
const posted = [];
const port = { postMessage: (m) => posted.push(m), close() {}, onmessage: null, onmessageerror: null };
frameBus.attachDetachedPort(port);
frameBus.setOperatorDedup(true);
const frame = { energy: 0 };
const palette = {};
const send = (operator) => frameBus.publish(frame, palette, 16, operator);
const look = { version: 1, name: 'settled', zoom: { base: 1 } };
send(look);
send(look);
send({ ...look, zoom: { base: 1 } });
check(posted[0].operator && !posted[0].operatorUnchanged, 'the first tick must carry the operator');
check(posted[1].operatorUnchanged === true && !posted[1].operator, 'an identical second tick must be skipped');
check(posted[2].operatorUnchanged === true, 'an equal copy must be skipped by content');
look.zoom.base = 2;
send(look);
check(posted[3].operator && posted[3].operator.zoom.base === 2, 'an in-place edit must be sent');
send({ ...look, _transition: 0.5, _from: look, _to: look });
send(look);
check(posted[4].operator, 'a fade tick must always carry the operator');
check(posted[5].operator, 'the first settled tick after a fade must carry the operator');
frameBus.detachPort();
posted.length = 0;
frameBus.attachDetachedPort(port);
send(look);
check(posted[0]?.operator, 'a freshly attached window must get a full operator');

console.log(log.join('\n') || 'frame-bus operator carry: ok');
process.exit(pass ? 0 : 1);
