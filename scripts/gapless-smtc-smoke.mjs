// Windows only. The OS media controls (the volume flyout, the lock screen)
// list NewAmp only while one of its media elements plays, and the
// sample-accurate gapless transport renders through Web Audio alone, so the
// engine keeps a silent element playing beside it. This runs the muted
// queue-edit smoke (40 s tracks, gapless on by default) while polling the
// system media session manager from PowerShell, then checks that a session
// for the playing track showed up as Playing, and that its timeline is the
// track's 40 s (the page's position state), not the silent element's 1 s loop.
//
// Run: npm run build, then node scripts/gapless-smtc-smoke.mjs

import { spawn } from 'node:child_process';

if (process.platform !== 'win32') {
  console.error('[gapless-smtc-smoke] SKIP: the system media session query is Windows only');
  process.exit(0);
}

const TRACK_SECONDS = 40;
const POLL_SECONDS = 120;

const POLLER = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$deadline = (Get-Date).AddSeconds(${POLL_SECONDS})
while ((Get-Date) -lt $deadline) {
  $rows = @()
  foreach ($session in $manager.GetSessions()) {
    try {
      $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $timeline = $session.GetTimelineProperties()
      $rows += [pscustomobject]@{
        app = $session.SourceAppUserModelId
        title = $props.Title
        artist = $props.Artist
        status = [string]$session.GetPlaybackInfo().PlaybackStatus
        endSec = $timeline.EndTime.TotalSeconds
        positionSec = $timeline.Position.TotalSeconds
      }
    } catch { }
  }
  if ($rows.Count -eq 0) { 'POLL []' } else { 'POLL ' + (ConvertTo-Json -Compress -InputObject @($rows)) }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 250
}
`;

const polls = [];
const poller = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POLLER], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let pollerErr = '';
let buffered = '';
let firstPoll;
const ready = new Promise((resolve) => {
  firstPoll = resolve;
});
poller.stdout.setEncoding('utf8');
poller.stdout.on('data', (chunk) => {
  buffered += chunk;
  const lines = buffered.split(/\r?\n/);
  buffered = lines.pop();
  for (const line of lines) {
    if (!line.startsWith('POLL ')) continue;
    const parsed = JSON.parse(line.slice(5));
    polls.push({ at: Date.now(), sessions: Array.isArray(parsed) ? parsed : [parsed] });
    firstPoll();
  }
});
poller.stderr.setEncoding('utf8');
poller.stderr.on('data', (chunk) => {
  pollerErr += chunk;
});
poller.on('exit', () => firstPoll());

await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 30000))]);
if (!polls.length) {
  console.error(`[gapless-smtc-smoke] FAIL: the media session query never answered\n${pollerErr.slice(-2000)}`);
  poller.kill();
  process.exit(1);
}

const smokeStarted = Date.now();
const smoke = spawn(process.execPath, ['scripts/ui-queue-edit-smoke.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let smokeOut = '';
smoke.stdout.setEncoding('utf8');
smoke.stderr.setEncoding('utf8');
smoke.stdout.on('data', (chunk) => {
  smokeOut += chunk;
});
smoke.stderr.on('data', (chunk) => {
  smokeOut += chunk;
});
const smokeExit = await new Promise((resolve) => smoke.on('exit', (code) => resolve(code)));
const smokeEnded = Date.now();
poller.kill();

const ours = polls
  .filter((poll) => poll.at >= smokeStarted && poll.at <= smokeEnded + 1000)
  .flatMap((poll) => poll.sessions.filter((s) => /^Queue (One|Two|Three)$/.test(String(s.title ?? ''))).map((s) => ({ ...s, atMs: poll.at - smokeStarted })));
const playing = ours.filter((s) => s.status === 'Playing');
const report = {
  smokeExit,
  pollsDuringSmoke: polls.filter((poll) => poll.at >= smokeStarted && poll.at <= smokeEnded).length,
  sessionSeen: ours.length > 0,
  playingSeen: playing.length > 0,
  apps: [...new Set(ours.map((s) => s.app))],
  titles: [...new Set(ours.map((s) => s.title))],
  statuses: [...new Set(ours.map((s) => s.status))],
  timelineEndSec: [...new Set(playing.map((s) => Math.round(s.endSec * 10) / 10))],
  firstPlayingAtMs: playing[0]?.atMs ?? null,
};
console.log(JSON.stringify(report, null, 2));

// The queue edits are that smoke's own business; a Playing session for its
// track already shows the app played. Without one, its output says why.
if (smokeExit !== 0) console.error(`[gapless-smtc-smoke] note: the queue-edit smoke exited ${smokeExit}\n${smokeOut.slice(-1200)}`);
const problems = [];
if (!report.playingSeen) problems.push(`no Playing media session for the gapless track (queue-edit smoke exited ${smokeExit})`);
if (report.playingSeen && !playing.every((s) => Math.abs(s.endSec - TRACK_SECONDS) < 1)) {
  problems.push(`the session timeline is not the track's ${TRACK_SECONDS} s: ${report.timelineEndSec.join(', ')}`);
}
if (problems.length) {
  console.error(`[gapless-smtc-smoke] FAIL\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.error('[gapless-smtc-smoke] PASS');
