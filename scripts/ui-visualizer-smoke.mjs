import assert from 'node:assert/strict';
import electronPath from 'electron';
import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const appRoot = resolve('.');
const smokeRoot = resolve('tmp', 'ui-visualizer-smoke');
const userData = join(smokeRoot, 'user-data');
const mediaDir = join(smokeRoot, 'media');
const fixturePath = join(mediaDir, 'Newamp UI Visualizer Smoke.mp3');
const marker = '[newamp-ui-visualizer-smoke] ';

if (!ffmpeg) {
  console.error('ffmpeg-static did not resolve a binary for this platform');
  process.exit(1);
}

await resetSmokeRoot();
await createFixture();
await writeSmokeSettings();

const result = await runElectronSmoke();
assert.equal(result.ok, true, 'UI visualizer smoke should report success');
assert.match(result.currentTitle, /Visualizer Smoke/, 'visualizer smoke should play the generated fixture');
assert.equal(result.preset, 'spectrum', 'fullscreen visualizer should render the stable spectrum preset');
assert.ok(result.stageRect.width >= result.viewport.width * 0.9, 'fullscreen visualizer should cover viewport width');
assert.ok(result.stageRect.height >= result.viewport.height * 0.9, 'fullscreen visualizer should cover viewport height');
assert.ok(result.render.width >= 120, `visualizer canvas width is too small: ${result.render.width}`);
assert.ok(result.render.height >= 80, `visualizer canvas height is too small: ${result.render.height}`);
assert.ok(result.render.litSamples > 0, 'visualizer canvas should contain nonblank pixels');
assert.ok(result.xboxRender?.plasmaGrid?.litSamples > 0, 'Plasma Grid should render nonblank pixels');
assert.ok(result.xboxRender?.neonRibbons?.litSamples > 0, 'Neon Ribbons should render nonblank pixels');
assert.ok(result.xboxRender?.orbitalRings?.litSamples > 0, 'Orbital Rings should render nonblank pixels');
assert.ok(result.auroraRender?.litSamples > 0, 'Aurora should render a nonblank reactive frame');
assert.equal(result.qualityToggle, '4k', 'fullscreen visualizer should expose and apply 4K mode');
assert.ok(['armed', 'pulse'].includes(result.artToggle), 'fullscreen visualizer should expose random album-art pulse mode');
assert.equal(result.screenToggle, true, 'fullscreen visualizer should expose native full-screen screen takeover');
assert.equal(result.chromeMode, 'clean', 'fullscreen visualizer should expose a clean cinema mode');
assert.notEqual(result.palette, 'theme', 'fullscreen visualizer should apply color palette changes');
assert.equal(result.navMode, 'visible', 'fullscreen visualizer top nav should hide and restore cleanly');
assert.equal(result.performanceMode, 'balanced', 'fullscreen visualizer low-end mode should toggle and restore');
assert.equal(result.openedViaVizButton, true, 'regular UI VIZ button should open the fullscreen visualizer');
assert.equal(result.openedViaTransportArt, true, 'transport album art should open the fullscreen visualizer');
assert.equal(result.compactClearsFullscreen, true, 'entering deck mode should clear fullscreen visualizer state');
console.log(JSON.stringify(result, null, 2));

async function resetSmokeRoot() {
  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(mediaDir, { recursive: true });
  await mkdir(userData, { recursive: true });
}

async function createFixture() {
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=4.2',
    '-metadata',
    'title=Visualizer Smoke',
    '-metadata',
    'artist=Newamp QA',
    '-metadata',
    'album=Renderer Smoke',
    '-metadata',
    'date=2026',
    '-c:a',
    'libmp3lame',
    '-q:a',
    '6',
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
        NEWAMP_UI_VISUALIZER_SMOKE: '1',
        NEWAMP_SMOKE_USER_DATA: userData,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      finish(new Error(`UI visualizer smoke timed out without result marker. stderr:\n${tail(stderr)}`));
    }, 45000);

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
        finish(new Error(`Electron exited ${code ?? 'without code'} before UI visualizer result.\nstderr:\n${tail(stderr)}`));
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
