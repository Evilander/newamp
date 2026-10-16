// Many internet radio stations only stream over plain http, and the renderer's
// media-src allowed https: alone, so those stations never started. The fix
// opens http: for media and nothing else:
//   1. media-src takes http: next to https: and the custom schemes,
//   2. no other directive gains http: (script, style, frame, connect, img),
//   3. the Radio view's audio element is not made a CORS request, which would
//      refuse the many stations that send no CORS headers even once http: is
//      allowed.
// The packaged-renderer behaviour is covered by npm run smoke:radio-http-stream.
//
// Run with: node scripts/radio-csp-test.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [indexHtml, radioView] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/views/RadioView.tsx', import.meta.url), 'utf8'),
]);

const cspMeta = indexHtml.match(/<meta\s+[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i);
assert.ok(cspMeta, 'index.html must define a Content-Security-Policy meta tag');
const csp = cspMeta[0].match(/content="([^"]+)"/i)?.[1];
assert.ok(csp, 'the CSP meta tag must carry a content attribute');

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

const media = directives.get('media-src');
assert.ok(media, 'media-src must be set');
for (const source of ['http:', 'https:', 'newamp:', 'blob:', "'self'"]) {
  assert.ok(media.includes(source), `media-src should allow ${source}`);
}

// http: is for media only. A bare `http:` scheme source anywhere else would
// let a renderer script load or send things over cleartext.
for (const [name, values] of directives) {
  if (name === 'media-src') continue;
  assert.ok(!values.includes('http:'), `${name} must not allow the http: scheme`);
}
assert.deepEqual(directives.get('default-src'), ["'self'"], 'default-src stays self-only');
assert.deepEqual(directives.get('script-src'), ["'self'"], 'script-src stays self-only');
assert.deepEqual(directives.get('style-src'), ["'self'", "'unsafe-inline'"], 'style-src is unchanged');
assert.ok(!directives.has('frame-src'), 'frame-src falls back to default-src; it must not be opened');
assert.deepEqual(directives.get('object-src'), ["'none'"]);
assert.ok(!directives.get('connect-src').includes('http:'), 'the renderer never fetches stream bytes, so connect-src stays https-only');

assert.doesNotMatch(radioView, /\.crossOrigin\s*=|\bcrossOrigin=/, 'the radio audio element must not make anonymous-CORS requests');

console.log('[radio-csp-test] PASS');
