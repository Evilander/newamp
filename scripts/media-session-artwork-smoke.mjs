// Windows only. Runs the renderer's media session code (src/lib/mediaSession.ts)
// in a hidden Electron window with the same newart:// protocol the app
// registers, plays a silent element so the page has a media session, and asks
// the system media session manager for the thumbnail it was given. The OS
// drops newart:// artwork, so before the cover was handed over as a blob URL
// this saw a session with no thumbnail at all.
//
// Run: node scripts/media-session-artwork-smoke.mjs

import electronPath from 'electron';
import ffmpeg from 'ffmpeg-static';
import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32') {
  console.error('[media-session-artwork-smoke] SKIP: the system media session query is Windows only');
  process.exit(0);
}
if (!ffmpeg) {
  console.error('ffmpeg-static did not resolve a binary for this platform');
  process.exit(1);
}

const root = resolve('tmp', 'media-session-artwork-smoke');
const TITLE = 'Artwork Smoke Song';
const TIME_LIMIT_MS = 45000;

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

function encode(args, out) {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-y', ...args, out], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${result.stderr}`);
}
encode(['-f', 'lavfi', '-i', 'gradients=s=1000x1000:c0=red:c1=blue:d=1', '-frames:v', '1'], join(root, 'cover.jpg'));
encode(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '60'], join(root, 'silence.wav'));

await build({
  stdin: {
    contents: `import { syncMediaSessionIdentity } from './src/lib/mediaSession';
      import { api } from './src/lib/api';
      window.__artSmoke = { syncMediaSessionIdentity, api };`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
  outfile: join(root, 'page.js'), define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent',
});

await writeFile(join(root, 'index.html'), `<!doctype html><meta charset="utf-8"><body>
<audio id="a" loop src="silence.wav"></audio>
<script src="page.js"></script>
<script>
(async () => {
  const { syncMediaSessionIdentity, api } = window.__artSmoke;
  api.getArtUrl = (id) => 'newart://track/' + id + '/art';
  await document.getElementById('a').play();
  const noop = () => {};
  syncMediaSessionIdentity({
    current: { id: 1, title: ${JSON.stringify(TITLE)}, artist: 'Smoke', album: 'Smoke', hasArt: 1 },
    isPlaying: true,
    actions: { play: noop, pause: noop, previous: noop, next: noop, stop: noop, seek: noop },
  });
  console.log('ART-SMOKE-READY');
})().catch((err) => console.log('ART-SMOKE-ERROR ' + err));
</script>`);

await writeFile(join(root, 'main.cjs'), `
const { app, BrowserWindow, protocol } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const dir = __dirname;
app.setPath('userData', join(dir, 'user-data'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
protocol.registerSchemesAsPrivileged([
  { scheme: 'newart', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
app.whenReady().then(async () => {
  const cover = readFileSync(join(dir, 'cover.jpg'));
  protocol.handle('newart', async () => new Response(cover, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (event) => console.log('[page] ' + (event.message ?? '')));
  await win.loadFile(join(dir, 'index.html'));
  setTimeout(() => app.quit(), ${TIME_LIMIT_MS});
});
`);

// Reads each session's thumbnail through the WinRT stream, because a session
// can report a Thumbnail object that holds nothing.
const POLLER = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$readStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
$deadline = (Get-Date).AddSeconds(${Math.ceil(TIME_LIMIT_MS / 1000) + 10})
while ((Get-Date) -lt $deadline) {
  $rows = @()
  foreach ($session in $manager.GetSessions()) {
    try {
      $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $thumbBytes = -1
      if ($props.Thumbnail) {
        try {
          $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
          $copy = New-Object System.IO.MemoryStream
          $readStream.Invoke($null, @($stream)).CopyTo($copy)
          $thumbBytes = [int]$copy.Length
        } catch { $thumbBytes = -2 }
      }
      $rows += [pscustomobject]@{ title = $props.Title; status = [string]$session.GetPlaybackInfo().PlaybackStatus; thumbBytes = $thumbBytes }
    } catch { }
  }
  if ($rows.Count -eq 0) { 'POLL []' } else { 'POLL ' + (ConvertTo-Json -Compress -InputObject @($rows)) }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 400
}
`;

const polls = [];
const poller = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POLLER], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let buffered = '';
let pollerErr = '';
poller.stdout.setEncoding('utf8');
poller.stdout.on('data', (chunk) => {
  buffered += chunk;
  const lines = buffered.split(/\r?\n/);
  buffered = lines.pop();
  for (const line of lines) {
    if (!line.startsWith('POLL ')) continue;
    const parsed = JSON.parse(line.slice(5));
    polls.push({ at: Date.now(), sessions: Array.isArray(parsed) ? parsed : [parsed] });
  }
});
poller.stderr.setEncoding('utf8');
poller.stderr.on('data', (chunk) => { pollerErr += chunk; });

const deadline = Date.now() + 30000;
while (!polls.length && Date.now() < deadline) await new Promise((done) => setTimeout(done, 250));
if (!polls.length) {
  console.error(`[media-session-artwork-smoke] FAIL: the media session query never answered\n${pollerErr.slice(-2000)}`);
  poller.kill();
  process.exit(1);
}

const started = Date.now();
const app = spawn(electronPath, [join(root, 'main.cjs')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let appOut = '';
app.stdout.on('data', (chunk) => { appOut += chunk; });
app.stderr.on('data', (chunk) => { appOut += chunk; });
const appExited = new Promise((done) => app.on('exit', done));

const ours = () => polls
  .filter((poll) => poll.at >= started)
  .flatMap((poll) => poll.sessions.filter((session) => session.title === TITLE));
while (Date.now() < started + TIME_LIMIT_MS) {
  if (ours().some((session) => session.thumbBytes > 0)) break;
  if (/ART-SMOKE-ERROR/.test(appOut)) break;
  await new Promise((done) => setTimeout(done, 300));
}
const seen = ours();
app.kill();
poller.kill();
await appExited;

const report = {
  sessionSeen: seen.length > 0,
  statuses: [...new Set(seen.map((session) => session.status))],
  thumbnailBytes: Math.max(-1, ...seen.map((session) => session.thumbBytes)),
};
console.log(JSON.stringify(report, null, 2));

const problems = [];
if (!report.sessionSeen) problems.push('no media session for the page ever appeared');
else if (report.thumbnailBytes < 0) problems.push('the media session has no thumbnail: the cover URL was dropped');
else if (report.thumbnailBytes === 0) problems.push('the media session thumbnail is empty');
if (problems.length) {
  console.error(`[media-session-artwork-smoke] FAIL\n  ${problems.join('\n  ')}\n${appOut.split('\n').filter((line) => /\[page\]/.test(line) && !/Security Warning/.test(line)).join('\n').slice(-1200)}`);
  process.exit(1);
}
console.error('[media-session-artwork-smoke] PASS');
