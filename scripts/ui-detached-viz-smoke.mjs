// Detached projector + production scrub gate. Boots the REAL app against a
// generated fixture library, plays a track, scrubs it (reading the real
// media-element playhead — catches restart-on-seek), then opens the detached
// visualizer and asserts the projector handshakes, renders frames, and paints
// non-black pixels. Run with:
//   npm run smoke:ui-detached-viz
import assert from 'node:assert/strict';
import electronPath from 'electron';
import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const appRoot = resolve('.');
const smokeRoot = resolve('tmp', 'ui-detached-viz-smoke');
const userData = join(smokeRoot, 'user-data');
const mediaDir = join(smokeRoot, 'media');
const fixturePath = join(mediaDir, 'Newamp Detached Smoke.mp3');
const marker = '[newamp-ui-detached-viz-smoke] ';

if (!ffmpeg) {
  console.error('ffmpeg-static did not resolve a binary for this platform');
  process.exit(1);
}

await resetSmokeRoot();
await createFixture();
await writeSmokeSettings();

const result = await runElectronSmoke();
assert.equal(result.ok, true, 'detached viz smoke should report success');
assert.match(result.title, /Detached Smoke/, 'smoke should play the generated fixture');
// Production-stack scrub: the probe already throws when the seek restarts;
// re-assert here so the contract is visible in one place.
assert.ok(
  result.scrubLanded > result.scrubTarget - 3 && result.scrubLanded < result.scrubTarget + 5,
  `scrub must land near ${result.scrubTarget}s, landed ${result.scrubLanded}s`,
);
assert.equal(result.detached.portAttached, true, 'projector must complete the frame-port handshake');
assert.ok(result.detached.framesRendered > 30, `projector must render frames (got ${result.detached.framesRendered})`);
assert.equal(result.detached.lastRenderError, '', 'projector must not be in a render-error state');
// Flagship composition: MilkDrop must mount, be failing over to the WebGL
// fallback, or still be healthily booting (occluded windows throttle the
// iframe's timers so the full preset catalog can outlast the smoke window —
// `bcReady && !bcFailed` proves the iframe is alive and progressing). The
// only failure is MilkDrop dead with no fallback.
assert.ok(
  result.detached.bcMounted ||
    result.detached.webglFallback ||
    (result.detached.bcReady && !result.detached.bcFailed),
  `projector MilkDrop layer is dead with no fallback: ${JSON.stringify(result.detached)}`,
);
// The literal regression: a black projector. capturePage (full composite —
// MilkDrop + scenes + events) requires >1.5% lit; the occluded-window fallback
// reads only the sparse reactor-event canvas, so any lit pixels prove life.
const litFloor = result.capture.source === 'capturePage' ? 0.015 : 0.0005;
assert.ok(
  result.capture.litFraction > litFloor,
  `projector must paint non-black pixels (litFraction=${result.capture.litFraction}, ${JSON.stringify(result.capture)})`,
);
console.log(JSON.stringify(result, null, 2));

async function resetSmokeRoot() {
  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(mediaDir, { recursive: true });
  await mkdir(userData, { recursive: true });
}

async function createFixture() {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    // 45s, kick-like 60Hz pulse + 880Hz tone so the reactor has onsets to
    // fire events from and the scrub target (20s) sits well inside the track.
    '-i', 'sine=frequency=880:duration=45',
    '-f', 'lavfi',
    '-i', 'sine=frequency=60:duration=45',
    '-filter_complex', '[1:a]volume=0.8,tremolo=f=2:d=0.9[bass];[0:a][bass]amix=inputs=2:normalize=0[a]',
    '-map', '[a]',
    '-metadata', 'title=Detached Smoke',
    '-metadata', 'artist=Newamp QA',
    '-metadata', 'album=Projector Smoke',
    '-metadata', 'date=2026',
    '-c:a', 'libmp3lame', '-q:a', '6',
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
        customSkin: null,
        lastfmEnabled: false,
        lastfmApiKey: null,
        lastfmSharedSecret: null,
        lastfmSessionKey: null,
        lastfmUsername: null,
        lastfmAuthToken: null,
        openaiApiKey: null,
        openaiModel: 'gpt-5.4-mini',
        firstLaunchTutorialSeen: true,
        crossfadeMs: 0,
        replayGain: 'off',
        limiterEnabled: true,
        preampDb: 0,
        resumeState: null,
        volume: 0,
        playbackRate: 1,
        audioOutputDeviceId: null,
        autoDjEnabled: false,
        autoDjTarget: 24,
        autoDjSmartRuleId: null,
        equalizer: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        eqEnabled: false,
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
        NEWAMP_UI_DETACHED_VIZ_SMOKE: '1',
        NEWAMP_SMOKE_USER_DATA: userData,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      finish(new Error(`detached viz smoke timed out at 180s without result marker. stdout tail:\n${tail(stdout)}\nstderr tail:\n${tail(stderr)}`));
    }, 180000);

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
        finish(new Error(`Electron exited ${code ?? 'without code'} before detached viz result.\nstderr:\n${tail(stderr)}`));
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
  return text.split(/\r?\n/).slice(-60).join('\n');
}
