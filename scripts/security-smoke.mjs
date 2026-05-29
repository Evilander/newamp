import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [indexHtml, mainSource, packageSource] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

const cspMeta = indexHtml.match(/<meta\s+[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i);

assert.ok(cspMeta, 'index.html must define a Content-Security-Policy meta tag');

const cspMatch = cspMeta[0].match(/content="([^"]+)"|content='([^']+)'/i);
assert.ok(cspMatch, 'Content-Security-Policy meta tag must define a content attribute');

const csp = cspMatch[1] ?? cspMatch[2];
const directives = new Map(
  csp
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...values] = part.split(/\s+/);
      return [name, values];
    }),
);

assert.deepEqual(directives.get('object-src'), ["'none'"], 'CSP should disable plugin/object loads');
assert.deepEqual(directives.get('base-uri'), ["'self'"], 'CSP should lock base-uri to self');
assert.ok(directives.get('script-src')?.includes("'self'"), 'script-src should allow app scripts');
assert.ok(!directives.get('script-src')?.includes("'unsafe-eval'"), 'script-src must not allow unsafe-eval');
assert.ok(directives.get('connect-src')?.includes('https:'), 'connect-src should allow HTTPS metadata APIs');
assert.ok(directives.get('connect-src')?.includes('newamp:'), 'connect-src should allow Newamp media fetches');
assert.ok(directives.get('connect-src')?.includes('newart:'), 'connect-src should allow Newamp art fetches');
assert.ok(directives.get('connect-src')?.includes('newplaylistart:'), 'connect-src should allow Newamp playlist art fetches');
assert.ok(directives.get('media-src')?.includes('newamp:'), 'media-src should allow custom audio URLs');
assert.ok(directives.get('media-src')?.includes('https:'), 'media-src should allow HTTPS podcast audio');
assert.ok(directives.get('img-src')?.includes('newart:'), 'img-src should allow cached art URLs');
assert.ok(directives.get('img-src')?.includes('newplaylistart:'), 'img-src should allow playlist art URLs');
assert.match(mainSource, /scheme: 'newamp-app'/, 'main process should register the packaged renderer app protocol');
assert.match(mainSource, /protocol\.handle\('newamp-app'/, 'main process should serve packaged renderer assets through newamp-app');
assert.ok(!/\bbypassCSP:\s*true\b/.test(mainSource), 'custom protocols should not bypass renderer CSP');
assert.match(packageSource, /"smoke:security"/, 'package.json should expose the security smoke');
assert.match(packageSource, /"smoke:release-secrets"/, 'package.json should expose release secret hygiene smoke');

// Butterchurn/Milkdrop is the only code that needs eval. It is isolated in a
// sandboxed iframe so the MAIN renderer can stay on script-src 'self' (asserted
// above). Confirm that frame exists and that ITS CSP is the one scoping
// 'unsafe-eval' — i.e. the eval surface really did move, it wasn't just removed.
const iframeHtml = await readFile(new URL('../butterchurn-iframe.html', import.meta.url), 'utf8');
const iframeCspMeta = iframeHtml.match(/<meta\s+[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i);
assert.ok(iframeCspMeta, 'butterchurn-iframe.html must define a Content-Security-Policy meta tag');
const iframeCspMatch = iframeCspMeta[0].match(/content="([^"]+)"|content='([^']+)'/i);
assert.ok(iframeCspMatch, 'butterchurn-iframe.html CSP must define a content attribute');
const iframeCsp = iframeCspMatch[1] ?? iframeCspMatch[2];
const iframeScriptSrc = iframeCsp
  .split(';')
  .map((part) => part.trim())
  .find((part) => part.startsWith('script-src'));
assert.ok(
  iframeScriptSrc?.includes("'unsafe-eval'"),
  'butterchurn-iframe.html must scope unsafe-eval to the sandboxed frame',
);

console.log(JSON.stringify({ ok: true, directives: directives.size, iframeScoped: true }, null, 2));
