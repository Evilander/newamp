import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBuildProvenance } from './build-provenance.mjs';
import { createReleaseBundle } from './release-bundle.mjs';
import { writeReleaseChecksums } from './release-checksums.mjs';

// macOS notarization, mirroring scripts/sign-artifacts.mjs conventions:
//   - reads Apple credentials from the environment
//   - SKIPS CLEANLY (exit 0) when run off macOS or without credentials, so
//     unsigned dev builds and the secret-gated CI step never hard-fail
//   - submits each .dmg/.zip to Apple's notary service, staples the .dmg, then
//     refreshes the checksum manifest + provenance + bundle (stapling mutates
//     the .dmg bytes, so the SHA256 manifest must be recomputed)
//
// Credentials (either form):
//   NEWAMP_APPLE_ID + NEWAMP_APPLE_PASSWORD (app-specific) + NEWAMP_TEAM_ID
//   NEWAMP_NOTARY_KEYCHAIN_PROFILE  (a `notarytool store-credentials` profile)

const repoRoot = resolve('.');

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readPackageVersion(root = repoRoot) {
  return String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '').trim() || '0.0.0';
}

export function resolveNotarizationCredentials(env = process.env) {
  const keychainProfile = text(env.NEWAMP_NOTARY_KEYCHAIN_PROFILE);
  if (keychainProfile) {
    return { ok: true, mode: 'keychain-profile', keychainProfile };
  }
  const appleId = text(env.NEWAMP_APPLE_ID);
  const password = text(env.NEWAMP_APPLE_PASSWORD);
  const teamId = text(env.NEWAMP_TEAM_ID);
  if (appleId && password && teamId) {
    return { ok: true, mode: 'apple-id', appleId, password, teamId };
  }
  return {
    ok: false,
    reason:
      'no Apple notarization credentials: set NEWAMP_NOTARY_KEYCHAIN_PROFILE, or NEWAMP_APPLE_ID + NEWAMP_APPLE_PASSWORD + NEWAMP_TEAM_ID',
  };
}

export function findMacArtifacts(root = repoRoot) {
  const releaseDir = join(root, 'release');
  if (!existsSync(releaseDir)) return [];
  return readdirSync(releaseDir)
    .filter((name) => /^NewAmp .*\.(dmg|zip)$/i.test(name))
    .map((name) => ({ name, path: join(releaseDir, name), ext: name.split('.').pop().toLowerCase() }));
}

function notarytoolArgs(creds, artifactPath) {
  const args = ['notarytool', 'submit', artifactPath, '--wait'];
  if (creds.mode === 'keychain-profile') {
    args.push('--keychain-profile', creds.keychainProfile);
  } else {
    args.push('--apple-id', creds.appleId, '--team-id', creds.teamId, '--password', creds.password);
  }
  return args;
}

function redact(args, creds) {
  if (creds.mode !== 'apple-id') return args;
  return args.map((arg) => (arg === creds.password ? '***' : arg));
}

function skip(reason) {
  console.log(JSON.stringify({ ok: true, skipped: true, reason }, null, 2));
  process.exit(0);
}

function main() {
  if (process.platform !== 'darwin') {
    skip('notarization is macOS-only; skipping on ' + process.platform);
  }

  const creds = resolveNotarizationCredentials();
  if (!creds.ok) {
    // Unsigned dev build: the .app runs locally via right-click → Open.
    skip(creds.reason);
  }

  const xcrun = spawnSync('xcrun', ['--find', 'notarytool'], { encoding: 'utf8' });
  if (xcrun.status !== 0) {
    skip('xcrun notarytool not found (install Xcode command line tools)');
  }

  const artifacts = findMacArtifacts();
  if (!artifacts.length) {
    console.error('[newamp] no macOS artifacts found in release/ — run `npm run package:mac` first');
    process.exit(1);
  }

  // Preflight: verify the .app is Developer-ID-signed before wasting a notarytool round-trip.
  const _preflight = spawnSync(process.execPath, [new URL('./verify-mac-signing.mjs', import.meta.url).pathname], { stdio: 'inherit' });
  if (_preflight.status !== 0) {
    console.error('[notarize] signing preflight failed — aborting notarization');
    process.exit(_preflight.status ?? 1);
  }

  const results = [];
  for (const artifact of artifacts) {
    const args = notarytoolArgs(creds, artifact.path);
    console.log(`[newamp] notarizing ${artifact.name}: xcrun ${redact(args, creds).join(' ')}`);
    const submit = spawnSync('xcrun', args, { stdio: 'inherit' });
    if (submit.status !== 0) {
      console.error(`[newamp] notarization failed for ${artifact.name}`);
      process.exit(submit.status ?? 1);
    }
    // Only .dmg can be stapled; a .zip is notarized but Gatekeeper validates it
    // online (the .app inside would need stapling before zipping).
    if (artifact.ext === 'dmg') {
      const staple = spawnSync('xcrun', ['stapler', 'staple', artifact.path], { stdio: 'inherit' });
      if (staple.status !== 0) {
        console.error(`[newamp] stapler failed for ${artifact.name}`);
        process.exit(staple.status ?? 1);
      }
    }
    results.push({ name: artifact.name, notarized: true, stapled: artifact.ext === 'dmg' });
  }

  // Stapling rewrote the .dmg bytes — recompute the release metadata.
  const version = readPackageVersion();
  writeReleaseChecksums({ root: repoRoot, version });
  writeBuildProvenance({ root: repoRoot, version });
  createReleaseBundle({ root: repoRoot, version });

  console.log(JSON.stringify({ ok: true, skipped: false, mode: creds.mode, results }, null, 2));
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  main();
}
