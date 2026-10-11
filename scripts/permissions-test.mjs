// Unit tests for electron/permissions.ts: the session denies every web
// permission except the few the app uses, and only for its own pages.
// Run: node scripts/permissions-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/permissions-test-result.txt');
writeFileSync(RESULT, '[permissions-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/permissions.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/permissions-bundle.mjs'), logLevel: 'silent',
});
const { isPermissionAllowed, isAppOrigin, installPermissionHandlers } =
  await import(pathToFileURL(resolve('tmp/permissions-bundle.mjs')).href);

const log = [];
let pass = true;
const check = (label, actual, expected) => {
  log.push(`${label}: ${actual}`);
  if (actual !== expected) { pass = false; log.push(`FAIL: ${label} expected ${expected}, got ${actual}`); }
};

const allowedOrigins = ['newamp-app://app'];
const APP = 'newamp-app://app/index.html';
const ask = (permission, url = APP, extra = {}) => isPermissionAllowed({ permission, url, allowedOrigins, ...extra });

// What the app uses today.
check('output-device labels (audio media check)', ask('media', APP, { mediaTypes: ['audio'] }), true);
check('choosing an output device', ask('speaker-selection'), true);
check('fullscreen', ask('fullscreen'), true);
check('copying text to the clipboard', ask('clipboard-sanitized-write'), true);
check('the detached projector page', ask('speaker-selection', 'newamp-app://app/detached.html'), true);

// Never used by the app.
check('camera', ask('media', APP, { mediaTypes: ['video'] }), false);
check('camera and microphone together', ask('media', APP, { mediaTypes: ['audio', 'video'] }), false);
check('media with no type given', ask('media'), false);
check('unknown media type', ask('media', APP, { mediaTypes: ['unknown'] }), false);
for (const permission of [
  'midi', 'midiSysex', 'notifications', 'geolocation', 'clipboard-read', 'openExternal', 'display-capture',
  'pointerLock', 'keyboardLock', 'idle-detection', 'window-management', 'storage-access',
  'top-level-storage-access', 'mediaKeySystem', 'hid', 'usb', 'serial', 'fileSystem', 'unknown', '',
]) {
  check(`${permission || '(empty)'} is denied`, ask(permission), false);
}

// Right permission, wrong page.
check('web page asking for speaker-selection', ask('speaker-selection', 'https://example.com/'), false);
check('local file asking for fullscreen', ask('fullscreen', 'file:///C:/Users/x/page.html'), false);
check('data: page asking for the clipboard', ask('clipboard-sanitized-write', 'data:text/html,hi'), false);
check('lookalike host', ask('fullscreen', 'newamp-app://app.example.com/'), false);
check('same host on another scheme', ask('fullscreen', 'https://app/'), false);
check('no origin', isPermissionAllowed({ permission: 'fullscreen', url: undefined, allowedOrigins }), false);
check('empty origin', ask('fullscreen', ''), false);
check('unparseable origin', ask('fullscreen', 'not a url'), false);
check('bare origin string as the check handler sends it', ask('fullscreen', 'newamp-app://app'), true);
check('dev server is not allowed in a packaged session', ask('fullscreen', 'http://localhost:5173/'), false);
check('dev server allowed when listed', isPermissionAllowed({
  permission: 'fullscreen', url: 'http://localhost:5173/', allowedOrigins: [...allowedOrigins, 'http://localhost:5173'],
}), true);
check('isAppOrigin ignores path and query', isAppOrigin('newamp-app://app/index.html?newamp-smoke=1', allowedOrigins), true);

// Both handlers are installed and agree with the decision function.
const handlers = {};
const fakeSession = {
  setPermissionRequestHandler: (fn) => { handlers.request = fn; },
  setPermissionCheckHandler: (fn) => { handlers.check = fn; },
};
const denied = [];
installPermissionHandlers(fakeSession, {
  allowedOrigins,
  onDenied: ({ permission, url, mediaTypes, check }) =>
    denied.push(`${check ? 'check:' : ''}${permission}${mediaTypes ? `[${mediaTypes}]` : ''}@${url}`),
});
check('request handler installed', typeof handlers.request, 'function');
check('check handler installed', typeof handlers.check, 'function');

const decide = (permission, url, details = {}) => {
  let result = null;
  handlers.request({}, permission, (granted) => { result = granted; }, { isMainFrame: true, requestingUrl: url, ...details });
  return result;
};
check('request: midi from the app is denied', decide('midi', APP), false);
check('request: notifications from the app is denied', decide('notifications', APP), false);
check('request: microphone from the app is allowed', decide('media', APP, { mediaTypes: ['audio'] }), true);
check('request: camera from the app is denied', decide('media', APP, { mediaTypes: ['video'] }), false);
check('request: speaker-selection from a web page is denied', decide('speaker-selection', 'https://example.com/'), false);
check('request: the denials are reported', denied.join(','), `midi@${APP},notifications@${APP},media[video]@${APP},speaker-selection@https://example.com/`);
const requestDenials = denied.length;

check('check: fullscreen from the app', handlers.check(null, 'fullscreen', 'newamp-app://app', { isMainFrame: true }), true);
check('check: midi from the app', handlers.check(null, 'midi', 'newamp-app://app', { isMainFrame: true }), false);
check('check: audio media (device labels)', handlers.check(null, 'media', 'newamp-app://app', { isMainFrame: true, mediaType: 'audio' }), true);
check('check: video media', handlers.check(null, 'media', 'newamp-app://app', { isMainFrame: true, mediaType: 'video' }), false);
check('check: unknown media', handlers.check(null, 'media', 'newamp-app://app', { isMainFrame: true, mediaType: 'unknown' }), false);
check('check: clipboard-read', handlers.check(null, 'clipboard-read', 'newamp-app://app', { isMainFrame: true }), false);
check('check: foreign origin', handlers.check(null, 'fullscreen', 'https://example.com', { isMainFrame: true }), false);
check('check: falls back to the frame url', handlers.check(null, 'fullscreen', '', { isMainFrame: true, requestingUrl: APP }), true);

// A denied check says so once per kind, so a missing device label can be traced
// without a line per poll. An allowed check says nothing.
const checkDenials = () => denied.slice(requestDenials);
check('check: denials are reported', checkDenials().join(','), [
  'check:midi@newamp-app://app',
  'check:media[video]@newamp-app://app',
  'check:media[unknown]@newamp-app://app',
  'check:clipboard-read@newamp-app://app',
  'check:fullscreen@https://example.com',
].join(','));
handlers.check(null, 'media', 'newamp-app://app', { isMainFrame: true, mediaType: 'video' });
handlers.check(null, 'midi', 'newamp-app://app', { isMainFrame: true });
check('check: the same denial is not reported twice', checkDenials().length, 5);
handlers.check(null, 'midi', 'https://example.com', { isMainFrame: true });
check('check: the same permission from another origin is reported', checkDenials().length, 6);
handlers.check(null, 'media', 'newamp-app://app', { isMainFrame: true, mediaType: 'audio' });
check('check: an allowed check is never reported', checkDenials().length, 6);
const quiet = {};
installPermissionHandlers({ setPermissionRequestHandler() {}, setPermissionCheckHandler: (fn) => { quiet.check = fn; } }, { allowedOrigins });
check('check: no callback needed', quiet.check(null, 'midi', 'newamp-app://app', { isMainFrame: true }), false);

const report = log.join('\n') + '\n' + (pass ? '[permissions-test] PASS' : '[permissions-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
