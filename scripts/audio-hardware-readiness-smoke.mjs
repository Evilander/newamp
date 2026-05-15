import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const repoRoot = resolve('.');
const smokeRoot = resolve(repoRoot, 'tmp', 'audio-hardware-readiness');
const proofFile = join(smokeRoot, 'newamp-speaker-proof.mp3');

export async function checkAudioHardwareReadiness() {
  await mkdir(smokeRoot, { recursive: true });
  const endpoints = queryAudioEndpoints();
  const proof = await ensureSpeakerProofFile();
  const renderEndpoints = endpoints.filter((endpoint) => endpoint.direction === 'render');
  const activeRenderEndpoints = renderEndpoints.filter((endpoint) => endpoint.status === 'OK' || endpoint.status === 'Unknown');
  return {
    name: 'audio-hardware-readiness',
    ok: proof.ok && activeRenderEndpoints.length > 0,
    platform: process.platform,
    endpoints: {
      checked: endpoints.length > 0 || process.platform === 'win32',
      total: endpoints.length,
      render: renderEndpoints.length,
      activeRender: activeRenderEndpoints.length,
      sample: renderEndpoints.slice(0, 8),
    },
    proofFile: proof,
    manualChecklist: [
      'Open the generated proof file in Newamp.',
      'Confirm the intro tone is audible at comfortable volume.',
      'Confirm left/right channel changes are obvious on speakers/headphones.',
      'Switch Settings > Audio Output between System default and a real output device when available.',
      'Confirm crossfade/gapless playback has no clicks, drops, or unexpected silence on real hardware.',
    ],
  };
}

export function summarizeAudioHardware(report) {
  if (!report.proofFile?.ok) return report.proofFile?.reason ?? 'speaker proof file was not created';
  if (!report.endpoints?.activeRender) return 'no active Windows render audio endpoint was detected';
  return 'human speaker/headphone listening proof has not been recorded';
}

function queryAudioEndpoints() {
  if (process.platform !== 'win32') return [];
  const pnpEndpoints = queryWindowsPnpAudioEndpoints();
  const hasActiveRender = pnpEndpoints.some((endpoint) => endpoint.direction === 'render' && endpoint.status === 'OK');
  if (hasActiveRender) return pnpEndpoints;

  const registryEndpoints = queryWindowsRegistryAudioEndpoints();
  return registryEndpoints.length > 0 ? registryEndpoints : pnpEndpoints;
}

function queryWindowsPnpAudioEndpoints() {
  const command = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$items = @()
$items += Get-PnpDevice -Class AudioEndpoint | ForEach-Object {
  [pscustomobject]@{
    name = $_.FriendlyName
    status = [string]$_.Status
    class = [string]$_.Class
    instanceId = [string]$_.InstanceId
  }
}
$items | ConvertTo-Json -Compress
`;
  const result = runPowerShellJson(command);
  if (result.status !== 0 || result.error || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) return [];
      return [{
        name,
        status: typeof item.status === 'string' && item.status ? item.status : 'Unknown',
        class: typeof item.class === 'string' ? item.class : 'AudioEndpoint',
        source: 'pnp',
        direction: inferEndpointDirection(name, item.instanceId),
      }];
    });
  } catch {
    return [];
  }
}

function queryWindowsRegistryAudioEndpoints() {
  const command = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$base = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
$items = @()
if (Test-Path $base) {
  $items += Get-ChildItem -LiteralPath $base | ForEach-Object {
    $props = Get-ItemProperty -LiteralPath $_.PSPath
    $friendly = $null
    $propertyPath = Join-Path $_.PSPath 'Properties'
    if (Test-Path $propertyPath) {
      $friendly = (Get-ItemProperty -LiteralPath $propertyPath).'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
    }
    [pscustomobject]@{
      name = if ($friendly) { [string]$friendly } else { 'Windows render endpoint' }
      state = [int64]($props.DeviceState)
      instanceId = [string]$_.PSChildName
    }
  }
}
$items | ConvertTo-Json -Compress
`;
  const result = runPowerShellJson(command);
  if (result.status !== 0 || result.error || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const state = Number(item.state);
      const active = Number.isFinite(state) && (state & 1) === 1;
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'Windows render endpoint';
      return [{
        name,
        status: active ? 'OK' : 'Unavailable',
        class: 'AudioEndpoint',
        source: 'registry',
        direction: 'render',
        state,
        instanceId: typeof item.instanceId === 'string' ? item.instanceId : '',
      }];
    });
  } catch {
    return [];
  }
}

function runPowerShellJson(command) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 12_000,
  });
}

async function ensureSpeakerProofFile() {
  if (!ffmpeg) {
    return { ok: false, path: proofFile, reason: 'ffmpeg-static did not resolve a binary for this platform' };
  }

  const filter =
    '[0:a]pan=stereo|c0=c0|c1=c0[center1];' +
    '[1:a]pan=stereo|c0=c0|c1=0*c0[left];' +
    '[2:a]pan=stereo|c0=0*c0|c1=c0[right];' +
    '[3:a]pan=stereo|c0=c0|c1=c0[center2];' +
    '[center1][left][right][center2]concat=n=4:v=0:a=1[out]';
  const result = spawnSync(
    ffmpeg,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=660:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-filter_complex',
      filter,
      '-map',
      '[out]',
      '-metadata',
      'title=Newamp Speaker Proof',
      '-metadata',
      'artist=Newamp QA',
      '-metadata',
      'album=Hardware Readiness',
      '-metadata',
      'date=2026',
      '-c:a',
      'libmp3lame',
      '-q:a',
      '4',
      proofFile,
    ],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0 || !existsSync(proofFile)) {
    return {
      ok: false,
      path: proofFile,
      reason: `ffmpeg speaker proof generation failed (${result.status ?? 'unknown'}): ${(result.stderr || result.stdout || '').trim()}`,
    };
  }
  const stat = statSync(proofFile);
  return {
    ok: stat.size > 1000,
    path: proofFile,
    bytes: stat.size,
    sha256: createHash('sha256').update(readFileSync(proofFile)).digest('hex').toUpperCase(),
    durationSeconds: 8,
    sequence: ['center 440Hz', 'left 660Hz', 'right 880Hz', 'center 440Hz'],
  };
}

function inferEndpointDirection(name, instanceId) {
  const value = `${name} ${typeof instanceId === 'string' ? instanceId : ''}`.toLowerCase();
  if (/microphone|mic|capture|input/.test(value)) return 'capture';
  return 'render';
}

if (process.argv[1]?.replaceAll('\\', '/').toLowerCase().endsWith('/audio-hardware-readiness-smoke.mjs')) {
  const report = await checkAudioHardwareReadiness();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
