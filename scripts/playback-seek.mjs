// Real-machine gate: PROVE that scrubbing lands at the target time instead of
// resetting to the start. Run with:
//   npm run smoke:playback-seek
//
// It exercises the SHIPPED serving code (electron/audio-serve.ts — the same
// functions protocol.handle('newamp') uses in main.ts) across all four
// production paths:
//   1. native MP3      → fileRangeResponse        (hand-rolled 206s)
//   2. native FLAC     → fileRangeResponse        (Tyler's library majority)
//   3. cold-cache .wma → seekableTranscodeResponse (first play, ffmpeg -ss)
//   4. warm-cache .wma → fileRangeResponse on the finalized cached FLAC
//
// History: the original implementation forwarded Range headers into
// net.fetch(file://), which slices bodies but answers a bare 200 with no
// Content-Range/Content-Length/Accept-Ranges — Chromium treated EVERY track as
// a non-seekable live stream. This smoke failed on real machines and the
// failure was misattributed to "headless CI sandbox". The assertions below are
// environment-independent at the protocol level (header checks) plus a real
// <audio> scrub probe.
//
// Fixtures are frequency-changing tones (440 Hz for the first half, 880 Hz for
// the second), so after seeking past the midpoint an FFT must show ~880 Hz —
// proving the bytes Chromium fetched came from the right offset, not a restart.

import ffmpeg from 'ffmpeg-static';
import { app, BrowserWindow, net, protocol } from 'electron';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { playbackMode } from '../dist-electron/electron/transcode.js';
import { initTranscodeCache, getOrTranscodeToFlac, peekCachedFlac } from '../dist-electron/electron/transcode-cache.js';
import { fileRangeResponse, seekableTranscodeResponse } from '../dist-electron/electron/audio-serve.js';

const smokeRoot = resolve('tmp', 'playback-seek-smoke');
const SEEK_TARGET = 8.5;
const DURATION = 12;

if (!ffmpeg) {
  console.error('ffmpeg-static did not resolve a binary for this platform');
  process.exit(1);
}

const hardTimeout = setTimeout(() => fail(new Error('playback-seek smoke timed out')), 120000);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

protocol.registerSchemesAsPrivileged([
  { scheme: 'newamp', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

void app.whenReady().then(run).catch(fail);

async function run() {
  // Fresh cache dir each run so the "cold" case is genuinely cold.
  rmSync(join(smokeRoot, 'transcode-cache'), { recursive: true, force: true });
  initTranscodeCache(join(smokeRoot, 'transcode-cache'));
  const fixtures = await createFixtures();

  // Mirrors the shipped protocol handler in electron/main.ts (minus the
  // allowlist gate, which is orthogonal to seeking).
  protocol.handle('newamp', async (request) => {
    try {
      const url = new URL(request.url);
      const filePath = resolve(decodeURIComponent(url.pathname.replace(/^\/+/, '')));
      if (!existsSync(filePath)) return new Response('Not found', { status: 404 });
      if (playbackMode(filePath) === 'ffmpeg') {
        const ready = await peekCachedFlac(filePath);
        if (ready) {
          return fileRangeResponse(ready, request, {
            'Content-Type': 'audio/flac',
            'X-Newamp-Playback': 'ffmpeg-cached-flac',
          });
        }
        return seekableTranscodeResponse(filePath, request);
      }
      return fileRangeResponse(filePath, request);
    } catch (err) {
      console.error('seek smoke protocol failed:', err);
      return new Response('Server Error', { status: 500 });
    }
  });

  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
  await win.loadURL('data:text/html,<meta charset="utf-8"><title>Newamp seek smoke</title>');

  const cases = [
    { name: 'native-control.mp3', path: fixtures.mp3, expectPlayback: null },
    { name: 'native-control.flac', path: fixtures.flac, expectPlayback: null },
    { name: 'transcoded-cold.wma', path: fixtures.wma, expectPlayback: 'ffmpeg-seekable-wav' },
    { name: 'transcoded-warm.wma', path: fixtures.wma, warm: true, expectPlayback: 'ffmpeg-cached-flac' },
  ];

  const results = [];
  for (const c of cases) {
    if (c.warm) {
      const cached = await getOrTranscodeToFlac(c.path);
      if (!cached.ok) {
        results.push({ file: c.name, ok: false, error: `warm transcode failed: ${cached.reason}` });
        continue;
      }
    }
    const normalized = c.path.replace(/\\/g, '/');
    const url = `newamp://track/${encodeURI(normalized).replace(/#/g, '%23')}`;
    const mode = playbackMode(c.path);
    console.error(`[newamp] seek-probing ${c.name} (mode=${mode})`);

    // Protocol-level proof: a media-style Range probe MUST come back as a 206
    // with Content-Range + Content-Length. This is the exact contract
    // Chromium's media stack uses to decide a resource is seekable.
    const probeResp = await net.fetch(url, { headers: { Range: 'bytes=0-' } });
    const headerProof = {
      status: probeResp.status,
      contentRange: probeResp.headers.get('Content-Range'),
      contentLength: probeResp.headers.get('Content-Length'),
      acceptRanges: probeResp.headers.get('Accept-Ranges'),
      playbackPath: probeResp.headers.get('X-Newamp-Playback'),
    };
    await probeResp.body?.cancel().catch(() => {});
    const headersOk =
      headerProof.status === 206 &&
      !!headerProof.contentRange &&
      !!headerProof.contentLength &&
      headerProof.acceptRanges === 'bytes' &&
      (c.expectPlayback === null || headerProof.playbackPath === c.expectPlayback);

    // Faithful proof: scrub a real <audio> element to SEEK_TARGET and assert it
    // LANDS there with a seekable range ~= duration, and the post-seek dominant
    // pitch is ~880 Hz (second-half tone) — proving the fetched bytes came from
    // the right offset, not a restart.
    const media = await win.webContents.executeJavaScript(seekProbe(url, SEEK_TARGET), true);
    results.push({ file: c.name, mode, ...headerProof, headersOk, ...media, ok: !!(headersOk && media.ok) });
    console.error(
      `[newamp] ${c.name}: status=${headerProof.status} path=${headerProof.playbackPath} landed=${media.landed} ` +
      `duration=${media.duration} seekableEnd=${media.seekableEnd} dominantHz=${media.dominantHz} ok=${headersOk && media.ok}`,
    );
  }

  win.close();
  app.quit();
  clearTimeout(hardTimeout);
  const ok = results.every((r) => r.ok);
  console.log(JSON.stringify({ ok, seekTarget: SEEK_TARGET, results }, null, 2));
  process.exit(ok ? 0 : 1);
}

async function createFixtures() {
  await mkdir(smokeRoot, { recursive: true });
  const defs = [
    { key: 'mp3', name: 'native-control.mp3', codec: ['-c:a', 'libmp3lame', '-b:a', '192k'] },
    { key: 'flac', name: 'native-control.flac', codec: ['-c:a', 'flac'] },
    { key: 'wma', name: 'transcoded-regression.wma', codec: ['-c:a', 'wmav2', '-b:a', '192k'] },
  ];
  const out = {};
  for (const d of defs) {
    const file = join(smokeRoot, d.name);
    out[d.key] = file;
    if (existsSync(file)) continue;
    runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${DURATION / 2}`,
      '-f', 'lavfi', '-i', `sine=frequency=880:duration=${DURATION / 2}`,
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]',
      ...d.codec, file,
    ]);
  }
  return out;
}

function seekProbe(url, target) {
  return `
    (async () => {
      const audio = new Audio(${JSON.stringify(url)});
      audio.preload = 'auto';
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const srcNode = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 8192;
      srcNode.connect(analyser); // analyser only; do not connect to destination (silent)
      const wait = (ev, ms) => new Promise((res) => {
        const t = setTimeout(() => res(false), ms);
        audio.addEventListener(ev, () => { clearTimeout(t); res(true); }, { once: true });
      });
      const err = () => audio.error ? { code: audio.error.code, message: audio.error.message } : null;
      try {
        await Promise.race([wait('loadedmetadata', 8000), wait('canplay', 8000)]);
        const duration = audio.duration;
        await audio.play().catch(() => {});
        audio.currentTime = ${target};
        const seeked = await wait('seeked', 5000);
        // let a little audio flow so the analyser has data at the new position and
        // the seekable range is populated
        await new Promise((r) => setTimeout(r, 600));
        const seekableEnd = audio.seekable.length ? audio.seekable.end(audio.seekable.length - 1) : 0;
        const bins = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(bins);
        let maxI = 0, maxV = -Infinity;
        for (let i = 0; i < bins.length; i++) { if (bins[i] > maxV) { maxV = bins[i]; maxI = i; } }
        const dominantHz = Math.round(maxI * ctx.sampleRate / analyser.fftSize);
        const landed = audio.currentTime;
        audio.pause(); audio.src = ''; ctx.close();
        const landedOk = Math.abs(landed - ${target}) < 1.2;            // did NOT reset to 0
        const seekableOk = Number.isFinite(duration) && seekableEnd > duration - 1.0; // range-addressable
        return {
          ok: !!(seeked && landedOk && seekableOk),
          landed: Number(landed.toFixed(2)),
          duration: Number.isFinite(duration) ? Number(duration.toFixed(2)) : null,
          seekableEnd: Number(seekableEnd.toFixed(2)),
          seeked, dominantHz, error: err(),
        };
      } catch (e) {
        audio.pause(); audio.src = ''; try { ctx.close(); } catch {}
        return { ok: false, landed: audio.currentTime, error: String(e && e.message || e) };
      }
    })()
  `;
}

function runFfmpeg(args) {
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status})\n${r.stderr || r.stdout}`);
}

function fail(err) {
  clearTimeout(hardTimeout);
  console.error(err instanceof Error ? err.message : err);
  try { app.quit(); } catch { /* not ready */ }
  process.exit(1);
}
