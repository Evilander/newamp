// scripts/mac/coreaudio-state.c compiled on demand: an independent witness of
// a CoreAudio output's nominal sample rate and hog owner, used by hog-probe
// and the exclusive-output check in mac-verify.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Builds the helper under `outDir/bin` and returns its path; throws with clang's output when it cannot. */
export function buildCoreAudioHelper(outDir) {
  const helperPath = join(outDir, 'bin', 'coreaudio-state');
  mkdirSync(dirname(helperPath), { recursive: true });
  const build = spawnSync(
    'xcrun',
    ['clang', '-O1', '-Wall', '-o', helperPath, join(here, 'coreaudio-state.c'), '-framework', 'CoreAudio', '-framework', 'CoreFoundation'],
    { encoding: 'utf8' },
  );
  if (build.status !== 0) {
    throw new Error(`could not build the CoreAudio helper (is the Xcode command line tools install complete?)\n${build.stderr || build.stdout}`);
  }
  return helperPath;
}

/** Runs the helper; `json` is the last stdout line parsed, or null. */
export function coreAudio(helperPath, args) {
  const result = spawnSync(helperPath, args, { encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse((result.stdout || '').trim().split('\n').at(-1) || 'null');
  } catch {
    json = null;
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

/** The output device's state (name, uid, nominalRate, hogPid, availableRates, ...); the default output when `uid` is empty. */
export function coreAudioDeviceState(helperPath, uid) {
  const result = coreAudio(helperPath, uid ? ['get', uid] : ['get']);
  if (!result.json || result.json.error) throw new Error(`cannot read the output device: ${result.stdout || result.stderr}`);
  return result.json;
}

// The addon's device id is the hex of miniaudio's ma_device_id, which on
// CoreAudio is the device UID as a NUL-padded string.
export function addonIdFor(addon, uid) {
  for (const device of addon.listDevices()) {
    const text = Buffer.from(device.id, 'hex').toString('utf8').replace(/\0[\s\S]*$/, '');
    if (text === uid) return device.id;
  }
  return null;
}
