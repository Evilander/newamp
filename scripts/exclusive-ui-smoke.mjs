#!/usr/bin/env node
// End-to-end Bit-Perfect Exclusive smoke: boots the REAL app with a fixture
// library and bitPerfectExclusive pre-enabled, double-clicks a track, and
// asserts:
//   1. the native WASAPI path actually engaged (no silent fallback),
//   2. the playback clock advances from the native framesRendered counter,
//   3. analyserFftSum() > 0 — the Web Audio graph is silent in exclusive
//      mode, so ANY analyser energy proves the 30Hz native PCM tap →
//      AnalyserNode-emulation path that keeps every visualizer alive.
//
// Takes over the default audio device for ~3 quiet seconds (fixture is a
// -26dB sine). Windows-only: exits 0 as a no-op elsewhere. Audio-hardware
// tier — local release gate, never CI.

import assert from 'node:assert/strict';
import electronPath from 'electron';
import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32' && process.platform !== 'linux') {
  console.log('[exclusive-ui-smoke] unsupported platform — exclusive output is Windows/Linux, PASS (no-op).');
  process.exit(0);
}

const appRoot = resolve('.');
const smokeRoot = resolve('tmp', 'exclusive-ui-smoke');
const userData = join(smokeRoot, 'user-data');
const mediaDir = join(smokeRoot, 'media');
const fixturePath = join(mediaDir, 'NewAmp Exclusive Smoke.flac');
const marker = '[newamp-exclusive-ui-smoke] ';

if (!ffmpeg) {
  console.error('ffmpeg-static did not resolve a binary for this platform');
  process.exit(1);
}

await resetSmokeRoot();
await createFixture();
await writeSmokeSettings();

const result = await runElectronSmoke();
assert.equal(result.ok, true, 'exclusive UI smoke should report success');
assert.equal(result.exclusiveActive, true, `native exclusive path must engage (fallback: ${result.fallbackReason ?? 'none'})`);
assert.ok(result.negotiated && result.negotiated.format, 'negotiated format must be reported');
assert.ok(result.currentTime > 0.8, `exclusive clock should advance; got ${result.currentTime}`);
assert.ok(result.fftSum > 0, 'external PCM tap must feed the analyser surface (visualizers) while Web Audio is silent');
console.log(
  `[exclusive-ui-smoke] PASS — ${result.negotiated.deviceName}: ${result.negotiated.format} @ ${result.negotiated.sampleRate} Hz` +
    `${result.negotiated.bitPerfect ? ' (bit-perfect)' : ` (${result.negotiated.resampled ? 'resampled — device clock differs from source' : 'adapted'})`}` +
    `, clock ${result.currentTime.toFixed(2)}s, fftSum ${result.fftSum}`,
);

async function resetSmokeRoot() {
  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(mediaDir, { recursive: true });
  await mkdir(userData, { recursive: true });
}

async function createFixture() {
  // 48 kHz s16 FLAC: 48k is the overwhelmingly common exclusive-capable
  // device clock, giving the bit-perfect (rate-preserved) path its best shot;
  // the assertions themselves stay device-agnostic.
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=523.25:duration=8:sample_rate=48000',
    '-af',
    // Stereo: lavfi sine is mono, and a mono source honestly disqualifies the
    // strict bit-perfect claim (channel upmix) — duplicate to stereo so this
    // gate exercises the gold path on rate-matched devices.
    'volume=0.05,aformat=channel_layouts=stereo',
    '-metadata',
    'title=Exclusive Smoke',
    '-metadata',
    'artist=NewAmp QA',
    '-metadata',
    'album=Bit-Perfect Gate',
    '-metadata',
    'date=2026',
    '-c:a',
    'flac',
    '-sample_fmt',
    's16',
    fixturePath,
  ];
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !existsSync(fixturePath)) {
    throw new Error(`ffmpeg fixture generation failed (${result.status})\n${result.stderr || result.stdout}`);
  }
}

async function writeSmokeSettings() {
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify(
      {
        libraryRoots: [mediaDir],
        libraryAutoWatch: false,
        theme: 'classic',
        crossfadeMs: 0,
        replayGain: 'off',
        limiterEnabled: true,
        preampDb: 0,
        resumeState: null,
        volume: 0.1,
        playbackRate: 1,
        equalizer: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        eqEnabled: false,
        bitPerfectExclusive: true,
        bitPerfectExclusiveDeviceId: null,
      },
      null,
      2,
    ),
    'utf8',
  );
}

function runElectronSmoke() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(String(electronPath), ['.'], {
      cwd: appRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEWAMP_EXCLUSIVE_UI_SMOKE: '1',
        NEWAMP_SMOKE_USER_DATA: userData,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      finish(new Error(`exclusive UI smoke timed out without result marker. stderr:\n${tail(stderr)}`));
    }, 60000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith(marker)) continue;
        try {
          const parsed = JSON.parse(line.slice(marker.length));
          finish(null, parsed);
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => finish(err));
    child.on('exit', (code) => {
      if (!settled && code !== 0) {
        finish(new Error(`Electron exited ${code ?? 'without code'} before exclusive UI result.\nstderr:\n${tail(stderr)}`));
      }
    });

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!child.killed) child.kill();
      if (err) rejectPromise(err);
      else resolvePromise(value);
    }
  });
}

function tail(text) {
  return text.split(/\r?\n/).slice(-40).join('\n');
}
