import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseBundlePaths } from './release-bundle.mjs';
import { releaseChecksumsPath } from './release-checksums.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve('.');

export const MANUAL_LISTENING_REQUIREMENTS = [
  'playback',
  'outputSwitching',
  'crossfade',
  'gapless',
];

export function defaultManualListeningProofPath(root = repoRoot) {
  return resolve(root, 'release', 'manual-listening-proof.json');
}

export function defaultManualListeningArtifacts(root = repoRoot) {
  const version = appVersion(root);
  const bundlePaths = releaseBundlePaths({ root, version });
  return [
    { name: 'installer', path: resolve(root, 'release', `Newamp Setup ${version}.exe`) },
    { name: 'portable', path: resolve(root, 'release', `Newamp Portable ${version}.exe`) },
    { name: 'exe', path: resolve(root, 'release', 'win-unpacked', 'Newamp.exe') },
    { name: 'checksums', path: releaseChecksumsPath({ root }) },
    { name: 'source', path: bundlePaths.sourceZip },
    { name: 'manifest', path: bundlePaths.manifest },
    { name: 'bundle', path: bundlePaths.bundleZip },
  ];
}

export function recordManualListeningProof({
  proofPath = defaultManualListeningProofPath(),
  artifacts = defaultManualListeningArtifacts(),
  confirmations,
  notes = '',
} = {}) {
  const missingConfirmations = MANUAL_LISTENING_REQUIREMENTS.filter((key) => confirmations?.[key] !== true);
  if (missingConfirmations.length) {
    throw new Error(`Missing manual confirmations: ${missingConfirmations.join(', ')}`);
  }
  const artifactProof = artifactFingerprints(artifacts);
  const missingArtifacts = artifactProof.filter((artifact) => !artifact.exists);
  if (missingArtifacts.length) {
    throw new Error(`Missing release artifacts: ${missingArtifacts.map((artifact) => artifact.name).join(', ')}`);
  }
  const proof = {
    schemaVersion: 1,
    app: 'Newamp',
    createdAt: new Date().toISOString(),
    platform: process.platform,
    confirmations: Object.fromEntries(MANUAL_LISTENING_REQUIREMENTS.map((key) => [key, true])),
    artifacts: Object.fromEntries(artifactProof.map((artifact) => [artifact.name, artifact])),
    notes: String(notes ?? '').trim() || null,
  };
  mkdirSync(dirname(proofPath), { recursive: true });
  writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  return checkManualListeningProof({ proofPath, artifacts });
}

export function checkManualListeningProof({
  proofPath = defaultManualListeningProofPath(),
  artifacts = defaultManualListeningArtifacts(),
} = {}) {
  const artifactProof = artifactFingerprints(artifacts);
  if (!existsSync(proofPath)) {
    return {
      name: 'manual-listening-proof',
      ok: false,
      proofPath,
      reason: 'manual proof file is missing',
      requiredConfirmations: MANUAL_LISTENING_REQUIREMENTS,
      artifacts: artifactProof,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(proofPath, 'utf8'));
  } catch (err) {
    return {
      name: 'manual-listening-proof',
      ok: false,
      proofPath,
      reason: `manual proof file is not valid JSON: ${errorMessage(err)}`,
      requiredConfirmations: MANUAL_LISTENING_REQUIREMENTS,
      artifacts: artifactProof,
    };
  }

  const confirmations = parsed?.confirmations && typeof parsed.confirmations === 'object'
    ? parsed.confirmations
    : {};
  const missingConfirmations = MANUAL_LISTENING_REQUIREMENTS.filter((key) => confirmations[key] !== true);
  const mismatchedArtifacts = artifactProof.filter((artifact) => {
    const recorded = parsed?.artifacts?.[artifact.name];
    return !artifact.exists || !recorded || recorded.sha256 !== artifact.sha256 || recorded.bytes !== artifact.bytes;
  });
  const createdAt = typeof parsed?.createdAt === 'string' ? parsed.createdAt : null;
  const createdAtValid = createdAt ? Number.isFinite(Date.parse(createdAt)) : false;
  const ok = missingConfirmations.length === 0 && mismatchedArtifacts.length === 0 && createdAtValid;

  return {
    name: 'manual-listening-proof',
    ok,
    proofPath,
    createdAt,
    requiredConfirmations: MANUAL_LISTENING_REQUIREMENTS,
    missingConfirmations,
    mismatchedArtifacts: mismatchedArtifacts.map((artifact) => artifact.name),
    artifacts: artifactProof,
    reason: ok
      ? null
      : manualProofReason({ missingConfirmations, mismatchedArtifacts, createdAtValid }),
  };
}

export function summarizeManualListeningProof(report) {
  if (report.ok) return `manual proof recorded at ${report.createdAt}`;
  return report.reason ?? 'manual listening proof is missing or invalid';
}

function artifactFingerprints(artifacts) {
  return artifacts.map((artifact) => {
    if (!existsSync(artifact.path)) {
      return { name: artifact.name, path: artifact.path, exists: false, bytes: 0, sha256: null };
    }
    const stat = statSync(artifact.path);
    return {
      name: artifact.name,
      path: artifact.path,
      exists: true,
      bytes: stat.size,
      sha256: sha256(artifact.path),
    };
  });
}

function manualProofReason({ missingConfirmations, mismatchedArtifacts, createdAtValid }) {
  const parts = [];
  if (!createdAtValid) parts.push('manual proof timestamp is missing or invalid');
  if (missingConfirmations.length) parts.push(`missing confirmations: ${missingConfirmations.join(', ')}`);
  if (mismatchedArtifacts.length) {
    parts.push(`artifact hashes do not match current release files: ${mismatchedArtifacts.map((item) => item.name).join(', ')}`);
  }
  return parts.join('; ') || 'manual listening proof is invalid';
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}

function appVersion(root) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    return String(pkg.version ?? '').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parseCliArgs(argv) {
  const flags = new Set();
  let notes = '';
  let proofPath = defaultManualListeningProofPath();
  for (const arg of argv) {
    if (arg.startsWith('--notes=')) notes = arg.slice('--notes='.length);
    else if (arg.startsWith('--proof=')) proofPath = resolve(arg.slice('--proof='.length));
    else flags.add(arg);
  }
  return { flags, notes, proofPath };
}

function cliConfirmations(flags) {
  return {
    playback: flags.has('--confirm-playback'),
    outputSwitching: flags.has('--confirm-output-switching'),
    crossfade: flags.has('--confirm-crossfade'),
    gapless: flags.has('--confirm-gapless'),
  };
}

function printUsage() {
  console.log([
    'Usage:',
    '  node scripts/manual-listening-proof.mjs --check',
    '  node scripts/manual-listening-proof.mjs --record --confirm-playback --confirm-output-switching --confirm-crossfade --confirm-gapless [--notes="..."]',
    '',
    'Record only after listening to the current packaged build on real speakers/headphones.',
  ].join('\n'));
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const { flags, notes, proofPath } = parseCliArgs(process.argv.slice(2));
  try {
    if (flags.has('--record')) {
      const report = recordManualListeningProof({
        proofPath,
        confirmations: cliConfirmations(flags),
        notes,
      });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    } else if (flags.has('--check')) {
      const report = checkManualListeningProof({ proofPath });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    } else {
      printUsage();
    }
  } catch (err) {
    console.error(errorMessage(err));
    process.exitCode = 1;
  }
}
