import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checkAudioHardwareReadiness } from './audio-hardware-readiness-smoke.mjs';
import { checkManualListeningProof } from './manual-listening-proof.mjs';

const repoRoot = resolve('.');
const args = new Set(process.argv.slice(2));
const launch = args.has('--launch');
const dryRun = args.has('--dry-run') || !launch;
const version = appVersion();
const exePath = resolve(repoRoot, 'release', 'win-unpacked', 'Newamp.exe');

const hardware = await checkAudioHardwareReadiness();
const manualProof = checkManualListeningProof();
const proofFile = hardware.proofFile;
const launchArgs = proofFile?.path ? [proofFile.path] : [];
const launchReady = hardware.ok && proofFile?.ok && existsSync(exePath);
const report = {
  name: 'listening-proof-session',
  ok: launchReady,
  dryRun,
  appVersion: version,
  launch: {
    ready: launchReady,
    executed: false,
    exePath,
    args: launchArgs,
    reason: launchReady ? null : launchBlocker(hardware, exePath),
  },
  proofFile,
  checklist: hardware.manualChecklist,
  recordCommand:
    'npm run release:record-listening-proof -- --confirm-playback --confirm-output-switching --confirm-crossfade --confirm-gapless',
  checkCommand: 'npm run release:check-listening-proof',
  currentManualProof: {
    ok: manualProof.ok,
    proofPath: manualProof.proofPath,
    reason: manualProof.reason,
  },
};

if (launch && launchReady) {
  const child = spawn(exePath, launchArgs, {
    cwd: dirname(exePath),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  report.launch.executed = true;
  report.dryRun = false;
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;

function launchBlocker(hardware, exePath) {
  if (!existsSync(exePath)) return 'packaged win-unpacked Newamp.exe is missing; run npm run package first';
  if (!hardware.ok) return hardware.proofFile?.reason ?? 'audio hardware proof file could not be prepared';
  if (!hardware.proofFile?.ok) return 'speaker proof file is missing';
  return 'listening proof session is not launch-ready';
}

function appVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    return String(pkg.version ?? '').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
