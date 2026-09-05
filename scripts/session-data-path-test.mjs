import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { runInNewContext } from 'node:vm';

const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const block = main.slice(main.indexOf('const sessionData ='), main.indexOf('mkdirSync(sessionData,')).replace('process.env.APPDATA!', 'process.env.APPDATA');
function sessionPath(platform, env, userData, overrides = {}) {
  return runInNewContext(`${block}\nsessionData`, {
    process: { platform, env },
    resolve: (platform === 'win32' ? win32 : posix).resolve,
    app: { getPath: () => userData },
    appRoot: '/opt/NewAmp/resources/app.asar',
    sessionDataOverride: undefined,
    userDataOverride: undefined,
    smokeMode: false,
    ...overrides,
  });
}

assert.equal(sessionPath('linux', {}, '/home/test/.config/NewAmp'), '/home/test/.config/NewAmp/session-data');
assert.equal(sessionPath('darwin', {}, '/Users/test/Library/Application Support/NewAmp'), '/Users/test/Library/Application Support/NewAmp/session-data');
assert.equal(sessionPath('linux', { APPDATA: 'C:/foreign-profile' }, '/tmp/xdg/NewAmp'), '/tmp/xdg/NewAmp/session-data');
assert.equal(sessionPath('win32', { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }, 'C:\\profile\\NewAmp'), 'C:\\Users\\test\\AppData\\Local\\NewAmp\\session-data');
assert.equal(sessionPath('win32', {}, 'C:\\profile\\NewAmp'), 'C:\\profile\\NewAmp\\session-data');
assert.equal(sessionPath('linux', {}, '/tmp/profile', { userDataOverride: '/tmp/profile' }), '/tmp/profile/session-data');
assert.equal(sessionPath('linux', {}, '/tmp/profile', { sessionDataOverride: '/tmp/session' }), '/tmp/session');
assert.equal(sessionPath('linux', {}, '/tmp/smoke', { smokeMode: true }), '/tmp/smoke/session-data');
console.log('Session data paths: Linux, macOS, Windows, overrides and smoke profiles passed.');
