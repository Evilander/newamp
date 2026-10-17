// Exercises the native addon's CoreAudio hog mode against real hardware and
// reports what the system did, using scripts/mac/coreaudio-state.c as an
// independent witness of the device's sample rate and hog owner. This is the
// procedure for the macOS exclusive-output path described in the hog-mode
// notes: take the device at each sample rate, check the rate really changed,
// check that closing gives the device and its old rate back.
//
//   node scripts/mac/hog-probe.mjs                       dry run: list outputs, change nothing
//   node scripts/mac/hog-probe.mjs --run                 take the default output at several rates
//   node scripts/mac/hog-probe.mjs --run --device <uid>  a specific output (uid from the list)
//   node scripts/mac/hog-probe.mjs --run --busy-test --crash-test
//   node scripts/mac/hog-probe.mjs --run --device <uid> --rates 48000 --expect-refusal
//       for an output that should refuse (Bluetooth, AirPlay, some HDMI): passes
//       only if the open fails AND the device is left at its old rate
//
// --run takes the device away from other programs and changes the system
// sample rate for a few seconds at a time. Close music players first. Output
// is silence, so nothing is heard. If a run is interrupted, put the rate back
// with:  tmp/mac-verify/bin/coreaudio-state set-rate <hz>
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTable } from './parsers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
};
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

if (process.platform !== 'darwin') {
  console.log('[hog-probe] not macOS: CoreAudio hog mode only exists there. Nothing was run.');
  process.exit(0);
}

const run = flag('--run');
const holdMs = Number(option('--hold-ms', 1500));
const uidArg = option('--device', '');
const outDir = resolve(repoRoot, 'tmp', 'mac-verify');
const helperPath = join(outDir, 'bin', 'coreaudio-state');
const jsonPath = resolve(option('--json', join(outDir, 'hog-probe.json')));
const addonPath = join(repoRoot, 'native', 'newamp-audio', 'prebuilt', `darwin-${process.arch}`, 'newamp_audio.node');

function buildHelper() {
  mkdirSync(dirname(helperPath), { recursive: true });
  const build = spawnSync(
    'xcrun',
    ['clang', '-O1', '-Wall', '-o', helperPath, join(here, 'coreaudio-state.c'), '-framework', 'CoreAudio', '-framework', 'CoreFoundation'],
    { encoding: 'utf8' },
  );
  if (build.status !== 0) {
    console.error(`[hog-probe] could not build the CoreAudio helper (is the Xcode command line tools install complete?)\n${build.stderr || build.stdout}`);
    process.exit(1);
  }
}

function helper(args) {
  const result = spawnSync(helperPath, args, { encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse((result.stdout || '').trim().split('\n').at(-1) || 'null');
  } catch {
    json = null;
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

function deviceState(uid) {
  const result = helper(uid ? ['get', uid] : ['get']);
  if (!result.json || result.json.error) throw new Error(`cannot read the output device: ${result.stdout || result.stderr}`);
  return result.json;
}

async function pollUntil(read, accept, timeoutMs) {
  const started = Date.now();
  let last = read();
  while (!accept(last) && Date.now() - started < timeoutMs) {
    await sleep(25);
    last = read();
  }
  return { ok: accept(last), ms: Date.now() - started, state: last };
}

function loadAddon() {
  if (!existsSync(addonPath)) {
    console.error(`[hog-probe] native addon missing: ${addonPath}\n  build it first:  npm run build:native`);
    process.exit(1);
  }
  return createRequire(import.meta.url)(addonPath);
}

// The addon's device id is the hex of miniaudio's ma_device_id, which on
// CoreAudio is the device UID as a NUL-padded string.
function addonIdFor(addon, uid) {
  for (const device of addon.listDevices()) {
    const text = Buffer.from(device.id, 'hex').toString('utf8').replace(/\0[\s\S]*$/, '');
    if (text === uid) return device.id;
  }
  return null;
}

function pickFormat(formats, rate, wanted) {
  const at = formats.filter((f) => (f.channels === 2 || f.channels === 0) && (f.sampleRate === rate || f.sampleRate === 0));
  const names = new Set(at.map((f) => f.format));
  return wanted.find((name) => names.has(name)) ?? null;
}

function silence(rate, format, ms) {
  const bytesPerSample = { s16: 2, s24: 3, s32: 4, f32: 4 }[format];
  const frames = Math.round((rate * ms) / 1000);
  return { frames, buffer: Buffer.alloc(frames * 2 * bytesPerSample) };
}

if (flag('--child-hold')) {
  // Child of --crash-test: take the device, announce it, then wait to be killed.
  const addon = loadAddon();
  const rate = Number(option('--rate', 96000));
  const id = addonIdFor(addon, option('--device', '')) ?? undefined;
  addon.open({ deviceId: id, sampleRate: rate, channels: 2, format: option('--format', 's24'), exclusive: true, ringMs: 500 });
  console.log('READY');
  await sleep(60_000);
  process.exit(0);
}

buildHelper();
const listed = helper(['list']);
if (!listed.json) {
  console.error(`[hog-probe] cannot list output devices:\n${listed.stdout}${listed.stderr}`);
  process.exit(1);
}
console.log('Output devices:');
console.log(
  formatTable(
    listed.json.map((d) => ({
      name: d.name,
      uid: d.uid,
      transport: d.transport,
      rate: d.nominalRate,
      hog: d.hogPid,
      default: d.isDefault ? 'yes' : '',
      physical: d.physicalFormat ? `${d.physicalFormat.bits}-bit ${d.physicalFormat.format}` : '',
    })),
    [
      { key: 'name', title: 'Device' },
      { key: 'transport', title: 'Bus' },
      { key: 'rate', title: 'Rate' },
      { key: 'hog', title: 'Hog' },
      { key: 'default', title: 'Default' },
      { key: 'physical', title: 'Physical' },
      { key: 'uid', title: 'UID' },
    ],
  ),
);

const before = deviceState(uidArg);
const uid = before.uid;
const supported = (before.availableRates ?? []).flatMap(([lo, hi]) => [44100, 48000, 88200, 96000, 176400, 192000].filter((r) => r >= lo && r <= hi));
const requested = option('--rates', '').split(',').map(Number).filter((n) => n > 0);
const rates = (requested.length ? requested : [...new Set(supported)]).filter((r) => supported.includes(r) || requested.includes(r));
console.log(`\nTarget: ${before.name} (${uid}), currently ${before.nominalRate} Hz, hog owner ${before.hogPid}`);
console.log(`Rates to visit: ${rates.join(', ') || '(none the device lists)'}`);

if (!run) {
  console.log('\nDry run. Add --run to take the device and change its sample rate (see the notes at the top of this file).');
  process.exit(0);
}
if (before.hogPid !== -1) {
  console.error(`[hog-probe] the device is already owned by pid ${before.hogPid}. Quit that program and run again.`);
  process.exit(1);
}

const addon = loadAddon();
const addonId = addonIdFor(addon, uid);
if (!addonId) {
  console.error('[hog-probe] the addon does not list this device. Devices it sees:', addon.listDevices().map((d) => d.name).join(', '));
  process.exit(1);
}
const probe = addon.probeDevice(addonId);
const results = [];
const original = before.nominalRate;
const ladder = (option('--format', '') ? [option('--format', '')] : ['s24', 's32', 'f32', 's16']);

for (const rate of rates) {
  const row = { test: `exclusive ${rate} Hz`, verdict: 'FAIL', notes: [] };
  results.push(row);
  const format = pickFormat(probe.formats, rate, ladder);
  if (!format) {
    row.verdict = 'SKIP';
    row.notes.push('the probe lists no stereo format at this rate');
    continue;
  }
  row.format = format;
  try {
    const startedAt = Date.now();
    const opened = addon.open({ deviceId: addonId, sampleRate: rate, channels: 2, format, exclusive: true, ringMs: 500 });
    row.openMs = Date.now() - startedAt;
    const atOpen = deviceState(uid);
    row.rateAtOpenReturn = atOpen.nominalRate;
    row.hogAtOpenReturn = atOpen.hogPid;
    const settled = await pollUntil(() => deviceState(uid), (s) => s.nominalRate === rate, 3000);
    row.rateSettleMs = settled.ms;
    row.internal = `${opened.internalFormat}@${opened.internalSampleRate}`;
    row.physicalAfterOpen = settled.state.physicalFormat;
    const honest = opened.internalSampleRate === rate && opened.internalFormat === format;
    // The ring holds ringMs of audio (rounded up to a power of two), less than
    // the hold, so it is fed while the device plays, the way the app does it;
    // end-of-stream is set only once the last byte is queued.
    const { frames, buffer } = silence(rate, format, holdMs);
    let written = 0;
    const feed = () => {
      while (written < buffer.length) {
        const n = addon.write(buffer.subarray(written));
        if (n === 0) break;
        written += n;
      }
    };
    feed();
    addon.start();
    const drainBy = Date.now() + holdMs + 3000;
    let eosSet = false;
    let stats = addon.stats();
    while (Date.now() < drainBy) {
      if (written < buffer.length) feed();
      if (written === buffer.length && !eosSet) {
        addon.setEos(true);
        eosSet = true;
      }
      stats = addon.stats();
      if (eosSet && stats.drained) break;
      await sleep(20);
    }
    row.stats = { framesRendered: stats.framesRendered, expected: frames, underruns: stats.underruns, drained: stats.drained };
    const hogDuring = deviceState(uid).hogPid;
    addon.close();
    const restored = await pollUntil(() => deviceState(uid), (s) => s.hogPid === -1 && s.nominalRate === original, 3000);
    row.restoreMs = restored.ms;
    row.rateAfterClose = restored.state.nominalRate;
    row.hogAfterClose = restored.state.hogPid;
    if (row.rateAtOpenReturn !== rate) row.notes.push(`rate had not changed when open() returned (${row.rateAtOpenReturn}); it took ${row.rateSettleMs} ms`);
    if (!settled.ok) row.notes.push(`nominal rate never reached ${rate} (${settled.state.nominalRate})`);
    if (hogDuring !== process.pid) row.notes.push(`hog owner during playback was ${hogDuring}, not ${process.pid}`);
    if (!honest) row.notes.push(`addon reports ${row.internal}, asked for ${format}@${rate}`);
    if (stats.framesRendered !== frames || !stats.drained) row.notes.push(`rendered ${stats.framesRendered}/${frames} frames, drained=${stats.drained}`);
    if (stats.underruns !== 0) row.notes.push(`${stats.underruns} underruns`);
    if (!restored.ok) row.notes.push(`after close: hog ${restored.state.hogPid}, rate ${restored.state.nominalRate} (was ${original})`);
    const hard = settled.ok && hogDuring === process.pid && honest && stats.framesRendered === frames && stats.drained && restored.ok;
    row.verdict = hard ? (row.rateAtOpenReturn === rate ? 'PASS' : 'PASS*') : 'FAIL';
  } catch (err) {
    row.notes.push(`open or play threw: ${err.message}`);
    try {
      addon.close();
    } catch {
      /* already closed */
    }
    // A refused open must leave the device as it was found. The case this
    // exists for: the rate is accepted, the hog is refused, and the rate stays.
    const settled = await pollUntil(() => deviceState(uid), (s) => s.nominalRate === original && s.hogPid === -1, 2000);
    row.rateAfterFailure = settled.state.nominalRate;
    row.hogAfterFailure = settled.state.hogPid;
    if (!settled.ok) {
      row.notes.push(`the failed open leaked state: rate ${settled.state.nominalRate} Hz (was ${original}), hog owner ${settled.state.hogPid}. Restoring the rate now.`);
      helper(['set-rate', String(original), uid]);
    } else if (flag('--expect-refusal') && /hog mode|sample rate/.test(err.message)) {
      row.verdict = 'PASS';
      row.notes.push('refused cleanly, device state restored');
    }
  }
  await sleep(500);
}

if (flag('--busy-test')) {
  const row = { test: 'device owned by another process', verdict: 'FAIL', notes: [] };
  results.push(row);
  const holder = spawn(helperPath, ['hog', '4000', uid], { stdio: ['ignore', 'pipe', 'pipe'] });
  const firstLine = await new Promise((resolveLine) => {
    let text = '';
    holder.stdout.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) resolveLine(text.split('\n')[0]);
    });
    holder.on('exit', () => resolveLine(text.split('\n')[0] || ''));
  });
  const held = JSON.parse(firstLine || '{}');
  if (held.ownerWhileHeld !== held.pid) {
    row.verdict = 'SKIP';
    row.notes.push(`the helper could not take the device: ${firstLine}`);
  } else {
    const rate = rates.find((r) => r !== original) ?? rates[0];
    const format = pickFormat(probe.formats, rate, ladder);
    try {
      addon.open({ deviceId: addonId, sampleRate: rate, channels: 2, format, exclusive: true, ringMs: 500 });
      row.notes.push('open succeeded while another process owned the device');
      addon.close();
    } catch (err) {
      row.message = err.message;
      const state = deviceState(uid);
      row.rateAfterRefusal = state.nominalRate;
      if (!/hogged by another process/.test(err.message)) row.notes.push(`unexpected error text: ${err.message}`);
      if (state.nominalRate !== original) row.notes.push(`the sample rate moved to ${state.nominalRate} although open was refused`);
      row.verdict = row.notes.length ? 'FAIL' : 'PASS';
    }
  }
  await new Promise((resolveExit) => (holder.exitCode !== null ? resolveExit() : holder.on('exit', resolveExit)));
  await sleep(300);
}

if (flag('--crash-test')) {
  const row = { test: 'owner killed with SIGKILL', verdict: 'INFO', notes: [] };
  results.push(row);
  const rate = rates.find((r) => r !== original) ?? rates[0];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--run', '--child-hold', '--rate', String(rate), '--device', uid], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolveReady, rejectReady) => {
    child.stdout.on('data', (chunk) => String(chunk).includes('READY') && resolveReady());
    child.on('exit', () => rejectReady(new Error('child exited before taking the device')));
  }).catch((err) => row.notes.push(err.message));
  if (!row.notes.length) {
    child.kill('SIGKILL');
    await new Promise((resolveExit) => child.on('exit', resolveExit));
    const settled = await pollUntil(() => deviceState(uid), (s) => s.hogPid === -1, 3000);
    row.hogReleasedAfterKill = settled.ok;
    row.rateAfterKill = settled.state.nominalRate;
    row.notes.push(
      settled.ok ? 'CoreAudio released the hog when the owner died.' : `hog owner is still ${settled.state.hogPid} after the owner died.`,
    );
    if (settled.state.nominalRate !== original) {
      row.notes.push(`the sample rate stayed at ${settled.state.nominalRate} Hz (was ${original}); nothing restores it after a crash. Restoring it now.`);
      helper(['set-rate', String(original), uid]);
    }
  }
}

const after = deviceState(uid);
console.log('\n' + formatTable(
  results.map((r) => ({ test: r.test, format: r.format ?? '', verdict: r.verdict, detail: (r.notes ?? []).join('; ') })),
  [
    { key: 'test', title: 'Test' },
    { key: 'format', title: 'Format' },
    { key: 'verdict', title: 'Result' },
    { key: 'detail', title: 'Notes' },
  ],
));
console.log(`\nDevice at the end: ${after.nominalRate} Hz, hog owner ${after.hogPid} (started at ${original} Hz, ${before.hogPid}).`);
console.log('PASS* = passed, but the sample rate had not changed yet when open() returned (a race that the next track change can lose).');

mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, JSON.stringify({ at: new Date().toISOString(), device: before, rates, results, after }, null, 2));
console.log(`JSON: ${jsonPath}`);
const failed = results.some((r) => r.verdict === 'FAIL') || after.nominalRate !== original || after.hogPid !== -1;
if (after.nominalRate !== original) {
  console.error(`[hog-probe] the device was left at ${after.nominalRate} Hz. Restore it:  ${helperPath} set-rate ${original}`);
}
process.exit(failed ? 1 : 0);
