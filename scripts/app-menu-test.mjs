// Unit test for buildAppMenuTemplate (esbuild harness).
// Run: node scripts/app-menu-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/app-menu-test-result.txt');
writeFileSync(RESULT, '[app-menu-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/app-menu.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/app-menu-bundle.mjs'), logLevel: 'silent',
});
const { buildAppMenuTemplate } = await import(pathToFileURL(resolve('tmp/app-menu-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const mac = buildAppMenuTemplate('darwin', { appName: 'NewAmp', appVersion: '1.10.0' });
const roles = mac.map((m) => m.role).filter(Boolean);
log.push('darwin roles: ' + JSON.stringify(roles));
for (const want of ['appMenu', 'editMenu', 'viewMenu', 'windowMenu']) {
  if (!roles.includes(want)) fail(`darwin menu missing role ${want}`);
}

const win = buildAppMenuTemplate('win32', { appName: 'NewAmp', appVersion: '1.10.0' });
log.push('win32 template length: ' + win.length);
if (win.length !== 0) fail('non-darwin should return an empty template (keep current chromeless behavior)');

const report = log.join('\n') + '\n' + (pass ? '[app-menu-test] PASS' : '[app-menu-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
