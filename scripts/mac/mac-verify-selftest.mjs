// Checks the parts of scripts/mac-verify.mjs that do not need a Mac: the output
// parsers against samples of what the macOS tools print, the window-capture
// reader, the key-event encoding, and the early exit on other systems.
// Run: node scripts/mac/mac-verify-selftest.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KEYS,
  classifyLight,
  clip,
  findTrafficLights,
  formatTable,
  holdsAssertion,
  keyEvents,
  parseCodesignDetails,
  parseEntitlements,
  parseInterfaceStyle,
  parseLipoArchs,
  parsePmsetAssertions,
  parseSpctl,
  parseVersion,
  readBmp,
  summarize,
  versionAtLeast,
} from './parsers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const ADHOC = `Executable=/Applications/NewAmp.app/Contents/MacOS/NewAmp
Identifier=io.newamp.player
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1234 flags=0x10002(adhoc,runtime) hashes=30+7 location=embedded
Signature=adhoc
Info.plist entries=33
TeamIdentifier=not set
Runtime Version=26.0.0
Sealed Resources version=2 rules=13 files=250
Internal requirements count=0 size=12
`;
const adhoc = parseCodesignDetails(ADHOC);
assert.equal(adhoc.identifier, 'io.newamp.player');
assert.equal(adhoc.adhoc, true);
assert.equal(adhoc.hardenedRuntime, true);
assert.equal(adhoc.developerId, false);
assert.equal(adhoc.teamId, null);
assert.equal(adhoc.flags, '0x10002(adhoc,runtime)');
assert.equal(adhoc.runtimeVersion, '26.0.0');

const DEVID = `Executable=/Applications/NewAmp.app/Contents/MacOS/NewAmp
Identifier=io.newamp.player
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=900 flags=0x10000(runtime) hashes=20+7 location=embedded
Signature size=9000
Authority=Developer ID Application: Example Person (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Oct 15, 2026 at 10:00:00 AM
TeamIdentifier=ABCDE12345
`;
const devId = parseCodesignDetails(DEVID);
assert.equal(devId.developerId, true);
assert.equal(devId.adhoc, false);
assert.equal(devId.hardenedRuntime, true);
assert.equal(devId.teamId, 'ABCDE12345');
assert.equal(devId.authorities.length, 3);

const noRuntime = parseCodesignDetails('CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+1 location=embedded\nSignature=adhoc\n');
assert.equal(noRuntime.hardenedRuntime, false, 'flags without 0x10000 are not the hardened runtime');

const rejected = parseSpctl('/Applications/NewAmp.app: rejected\nsource=no usable signature\n', 3);
assert.equal(rejected.accepted, false);
assert.equal(rejected.source, 'no usable signature');
const accepted = parseSpctl('/Applications/NewAmp.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Example (ABCDE12345)\n', 0);
assert.equal(accepted.accepted, true);
assert.equal(accepted.notarized, true);

const entitlements = parseEntitlements(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
<true/>
<key>com.apple.security.cs.disable-library-validation</key><false/>
</dict></plist>`);
assert.deepEqual(entitlements, {
  'com.apple.security.cs.allow-jit': true,
  'com.apple.security.cs.allow-unsigned-executable-memory': true,
  'com.apple.security.cs.disable-library-validation': false,
});

assert.deepEqual(parseLipoArchs('x86_64 arm64\n'), ['x86_64', 'arm64']);
assert.deepEqual(parseLipoArchs('arm64'), ['arm64']);

const PMSET = `2026-10-15 19:20:01 -0500
Assertion status system-wide:
   BackgroundTask                 0
   ApplePushServiceTask           0
   UserIsActive                   1
   PreventUserIdleDisplaySleep    1
   PreventSystemSleep             0
   PreventUserIdleSystemSleep     1
Listed by owning process:
   pid 4321(NewAmp): [0x0001a2b30001b2a3] 00:00:05 PreventUserIdleDisplaySleep named: "Electron"
\tCreated for PID: 4321.
   pid 88(powerd): [0x0000001000019000] 00:10:11 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"
`;
const pmset = parsePmsetAssertions(PMSET);
assert.equal(pmset.system.PreventUserIdleDisplaySleep, 1);
assert.equal(pmset.system.PreventSystemSleep, 0);
assert.equal(pmset.processes.length, 2);
assert.equal(holdsAssertion(pmset, 4321, 'PreventUserIdleDisplaySleep'), true);
assert.equal(holdsAssertion(pmset, 88, 'PreventUserIdleDisplaySleep'), false);
assert.equal(holdsAssertion(pmset, 9999, 'PreventUserIdleDisplaySleep'), false);

assert.equal(parseInterfaceStyle('Dark\n', 0), 'dark');
assert.equal(parseInterfaceStyle('', 1), 'light');

assert.deepEqual(parseVersion('v22.12.0'), [22, 12, 0]);
assert.deepEqual(parseVersion('26.0'), [26, 0, 0]);
assert.equal(parseVersion('no digits'), null);
assert.equal(versionAtLeast([22, 12, 0], [22, 12, 0]), true);
assert.equal(versionAtLeast([22, 11, 9], [22, 12, 0]), false);
assert.equal(versionAtLeast([24, 0, 0], [22, 12, 0]), true);

// Window capture: a 24-bit bottom-up and a 32-bit top-down BMP with the three
// lights drawn at 2x, and one without.
function makeBmp({ width, height, bits, topDown, paint }) {
  const bytes = bits / 8;
  const stride = Math.floor((bits * width + 31) / 32) * 4;
  const buffer = Buffer.alloc(54 + stride * height, 0);
  buffer.write('BM', 0, 'latin1');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(topDown ? -height : height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(bits, 28);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const row = topDown ? y : height - 1 - y;
      const at = 54 + row * stride + x * bytes;
      buffer[at] = b;
      buffer[at + 1] = g;
      buffer[at + 2] = r;
      if (bytes === 4) buffer[at + 3] = 255;
    }
  }
  return buffer;
}
const GREY = [40, 40, 48];
const LIGHTS = [
  { cx: 28, color: [255, 95, 87] },
  { cx: 68, color: [254, 188, 46] },
  { cx: 108, color: [40, 200, 64] },
];
const withLights = (x, y) => {
  for (const light of LIGHTS) if (Math.hypot(x - light.cx, y - 36) <= 12) return light.color;
  return GREY;
};
for (const [bits, topDown] of [[24, false], [32, true], [32, false]]) {
  const bmp = readBmp(makeBmp({ width: 400, height: 120, bits, topDown, paint: withLights }));
  assert.equal(bmp.width, 400);
  assert.deepEqual(bmp.pixel(28, 36), [255, 95, 87], `${bits}-bit ${topDown ? 'top-down' : 'bottom-up'} pixel order`);
  const found = findTrafficLights(bmp, 2);
  assert.equal(found.visible, true, `lights found in ${bits}-bit ${topDown ? 'top-down' : 'bottom-up'}`);
  assert.equal(found.blank, false);
}
const bare = findTrafficLights(readBmp(makeBmp({ width: 400, height: 120, bits: 24, topDown: false, paint: () => GREY })), 2);
assert.equal(bare.visible, false);
assert.equal(bare.blank, true, 'a flat capture is reported as blank, not as "no lights"');
const greyLights = findTrafficLights(readBmp(makeBmp({ width: 400, height: 120, bits: 24, topDown: false, paint: (x, y) => (Math.hypot(x - 28, y - 36) <= 12 || Math.hypot(x - 68, y - 36) <= 12 ? [150, 150, 150] : GREY) })), 2);
assert.equal(greyLights.visible, false, 'grey (inactive) lights do not count as visible');
assert.equal(classifyLight([255, 95, 87]), 'close');
assert.equal(classifyLight([254, 188, 46]), 'minimize');
assert.equal(classifyLight([40, 200, 64]), 'zoom');
assert.equal(classifyLight([200, 200, 200]), null);
assert.throws(() => readBmp(Buffer.from('not a bitmap at all, just text that is long enough to pass the size check....')), /not a BMP/);

// CDP modifiers: Alt 1, Control 2, Meta 4, Shift 8.
const [down, up] = keyEvents({ ...KEYS.ArrowRight, meta: true });
assert.equal(down.type, 'rawKeyDown');
assert.equal(up.type, 'keyUp');
assert.equal(down.modifiers, 4);
assert.equal(down.code, 'ArrowRight');
assert.equal(down.windowsVirtualKeyCode, 39);
assert.equal(keyEvents({ ...KEYS.M, meta: true, shift: true })[0].modifiers, 12);
assert.equal(keyEvents({ ...KEYS.ArrowLeft, ctrl: true })[0].modifiers, 2);
assert.equal(keyEvents({ ...KEYS.Space })[0].modifiers, 0);

const table = formatTable([{ a: 'x', b: 'long value' }, { a: 'yy', b: '' }], [{ key: 'a', title: 'A' }, { key: 'b', title: 'Bee' }]);
assert.equal(table, 'A   Bee\n--  ----------\nx   long value\nyy');
assert.deepEqual(summarize([{ status: 'PASS' }, { status: 'FAIL' }, { status: 'PASS' }, { status: 'MANUAL' }]), { PASS: 2, FAIL: 1, SKIP: 0, INFO: 0, MANUAL: 1 });
assert.equal(clip('a  b\n c', 10), 'a b c');
assert.equal(clip('x'.repeat(20), 10).length, 10);

// The harness entry points: exit early with a message anywhere but a Mac, and
// list their checks everywhere.
const list = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'mac-verify.mjs'), '--list'], { encoding: 'utf8' });
assert.equal(list.status, 0, list.stderr);
for (const id of ['codesign', 'menu-structure', 'dock-menu', 'close-hides', 'activate-restores', 'fullscreen-simple', 'media-session', 'wheel-volume', 'quit-cmd-q']) {
  assert.match(list.stdout, new RegExp(`^${id}\\s`, 'm'), `--list should include ${id}`);
}
if (process.platform !== 'darwin') {
  for (const script of ['mac-verify.mjs', join('mac', 'hog-probe.mjs')]) {
    const run = spawnSync(process.execPath, [join(repoRoot, 'scripts', script)], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${script} should exit 0 off macOS: ${run.stderr}`);
    assert.match(run.stdout, /macOS/, `${script} should say it needs macOS`);
    assert.match(run.stdout, /Nothing was run/, `${script} should say nothing was run`);
  }
}

// Every action the CoreAudio helper documents is implemented.
const helper = readFileSync(join(here, 'coreaudio-state.c'), 'utf8');
for (const command of ['list', 'get', 'set-rate', 'hog', 'watch']) {
  assert.match(helper, new RegExp(`strcmp\\(command, "${command}"\\)`), `coreaudio-state.c should implement ${command}`);
}

console.log('[mac-verify-selftest] PASS');
