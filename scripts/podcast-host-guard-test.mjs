// Unit test for isBlockedPodcastHost (SSRF guard: no private/loopback fetches).
// esbuild harness. Run: node scripts/podcast-host-guard-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/podcast-host-guard-test-result.txt');
writeFileSync(RESULT, '[podcast-host-guard-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/podcasts.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/podcasts-bundle.mjs'), logLevel: 'silent',
});
const { isBlockedPodcastHost } = await import(pathToFileURL(resolve('tmp/podcasts-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const blocked = [
  'localhost', 'LOCALHOST', 'foo.localhost', 'printer.local',
  '127.0.0.1', '127.255.255.255', '10.1.2.3', '172.16.0.1', '172.31.255.255',
  '192.168.1.1', '169.254.169.254', '0.0.0.0',
  '::1', '[::1]', 'fc00::1', '[fdab::2]', 'fe80::1',
];
const allowed = [
  'example.com', '8.8.8.8', 'feeds.megaphone.fm', '172.32.0.1', '11.0.0.1',
  '192.169.0.1', '169.255.0.1', '2606:4700::1111',
];

for (const h of blocked) {
  if (!isBlockedPodcastHost(h)) fail(`should block: ${h}`);
}
for (const h of allowed) {
  if (isBlockedPodcastHost(h)) fail(`should allow: ${h}`);
}
log.push(`blocked ${blocked.length} / allowed ${allowed.length} host checks done`);

const report = log.join('\n') + '\n' + (pass ? '[podcast-host-guard-test] PASS' : '[podcast-host-guard-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
