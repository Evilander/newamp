// Unit test for planDeviceChange (Eviland-test harness style).
// Run: node scripts/device-change-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/device-change-test-result.txt');
writeFileSync(RESULT, '[device-change-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/audio/device-change.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/device-change-bundle.mjs'), logLevel: 'silent',
});
const { planDeviceChange } = await import(pathToFileURL(resolve('tmp/device-change-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const eq = (got, want, msg) => { log.push(`${msg}: ${got}`); if (got !== want) fail(`${msg} — expected ${want}, got ${got}`); };

eq(planDeviceChange(null, ['a', 'b']), 'noop', 'null selection → noop');
eq(planDeviceChange('a', ['a', 'b']), 'reapply', 'present device → reapply');
eq(planDeviceChange('z', ['a', 'b']), 'fallback', 'removed device → fallback');
eq(planDeviceChange('a', []), 'fallback', 'no devices → fallback');

const report = log.join('\n') + '\n' + (pass ? '[device-change-test] PASS' : '[device-change-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
