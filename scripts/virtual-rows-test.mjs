// Unit test for computeVisibleWindow (pure virtualization math). esbuild harness.
// Run: node scripts/virtual-rows-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/virtual-rows-test-result.txt');
writeFileSync(RESULT, '[virtual-rows-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/hooks/useVirtualRows.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/virtual-rows-bundle.mjs'), logLevel: 'silent',
  external: ['react'],
});
const { computeVisibleWindow } = await import(pathToFileURL(resolve('tmp/virtual-rows-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const eq = (got, want, msg) => { const a = JSON.stringify(got), b = JSON.stringify(want); log.push(`${msg}: ${a}`); if (a !== b) fail(`${msg} — expected ${b}`); };

const P = { rowHeight: 40, viewportH: 400, rowCount: 1000, overscan: 3 };
eq(computeVisibleWindow({ ...P, scrollTop: 0 }), { startIndex: 0, endIndex: 13, topPad: 0, bottomPad: (1000 - 14) * 40 }, 'top of list');
eq(computeVisibleWindow({ ...P, scrollTop: 4000 }), { startIndex: 97, endIndex: 113, topPad: 97 * 40, bottomPad: (1000 - 114) * 40 }, 'middle');
const bottom = computeVisibleWindow({ ...P, scrollTop: (1000 * 40) - 400 });
log.push('bottom: ' + JSON.stringify(bottom));
if (bottom.endIndex !== 999) fail('bottom endIndex should clamp to 999');
if (bottom.bottomPad !== 0) fail('bottom bottomPad should be 0');
if (bottom.topPad !== bottom.startIndex * 40) fail('bottom topPad mismatch');
const tiny = computeVisibleWindow({ rowHeight: 40, viewportH: 400, rowCount: 3, overscan: 3, scrollTop: 0 });
eq(tiny, { startIndex: 0, endIndex: 2, topPad: 0, bottomPad: 0 }, 'tiny list');

const report = log.join('\n') + '\n' + (pass ? '[virtual-rows-test] PASS' : '[virtual-rows-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
