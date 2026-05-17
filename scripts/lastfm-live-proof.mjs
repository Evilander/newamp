import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { releaseBundlePaths } from './release-bundle.mjs';
import { releaseChecksumsPath } from './release-checksums.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve('.');

export const lastfmLiveProofTrack = {
  artist: 'Radiohead',
  title: 'Creep',
  album: 'Pablo Honey',
  albumArtist: 'Radiohead',
  duration: 238,
  trackNumber: 2,
};

export function defaultLastfmLiveProofPath(root = repoRoot) {
  return resolve(root, 'release', 'lastfm-live-proof.json');
}

export function defaultLastfmLiveProofArtifacts(root = repoRoot) {
  const version = appVersion(root);
  const bundlePaths = releaseBundlePaths({ root, version });
  return [
    { name: 'installer', path: resolve(root, 'release', `NewAmp Setup ${version}.exe`) },
    { name: 'portable', path: resolve(root, 'release', `NewAmp Portable ${version}.exe`) },
    { name: 'exe', path: resolve(root, 'release', 'win-unpacked', 'NewAmp.exe') },
    { name: 'checksums', path: releaseChecksumsPath({ root }) },
    { name: 'source', path: bundlePaths.sourceZip },
    { name: 'manifest', path: bundlePaths.manifest },
    { name: 'bundle', path: bundlePaths.bundleZip },
  ];
}

export async function startLastfmLiveProof({
  env = process.env,
  settingsPaths = lastfmSettingsPathCandidates(env),
} = {}) {
  const credentials = resolveLastfmCredentials({ env, settingsPaths });
  if (!credentials.apiKey || !credentials.sharedSecret) {
    throw new Error('Missing Last.fm API key/shared secret in env or saved app settings.');
  }
  const lastfm = await import(pathToFileURL(resolve(repoRoot, 'dist-electron', 'electron', 'lastfm.js')));
  const auth = await lastfm.startLastfmAuth(lastfmSettings({
    apiKey: credentials.apiKey,
    sharedSecret: credentials.sharedSecret,
  }));
  return {
    name: 'lastfm-live-proof-session',
    ok: true,
    mode: 'start',
    authUrl: auth.authUrl,
    token: auth.token,
    credentialSources: credentials.sources,
    nextStep: 'Open authUrl, approve NewAmp in Last.fm, then run npm run release:record-lastfm-proof -- --token=<token> --confirm-live-write',
  };
}

export async function recordLastfmLiveProof({
  token,
  proofPath = defaultLastfmLiveProofPath(),
  artifacts = defaultLastfmLiveProofArtifacts(),
  env = process.env,
  settingsPaths = lastfmSettingsPathCandidates(env),
  confirmLiveWrite = false,
} = {}) {
  const authToken = text(token) || text(env.NEWAMP_LASTFM_AUTH_TOKEN) || text(env.LASTFM_AUTH_TOKEN);
  if (!authToken) throw new Error('Missing Last.fm auth token. Start the proof session first.');
  if (!confirmLiveWrite && env.NEWAMP_LASTFM_LIVE_WRITE !== '1') {
    throw new Error('Refusing to write a Last.fm Now Playing proof without --confirm-live-write or NEWAMP_LASTFM_LIVE_WRITE=1.');
  }
  const credentials = resolveLastfmCredentials({ env, settingsPaths });
  if (!credentials.apiKey || !credentials.sharedSecret) {
    throw new Error('Missing Last.fm API key/shared secret in env or saved app settings.');
  }

  const lastfm = await import(pathToFileURL(resolve(repoRoot, 'dist-electron', 'electron', 'lastfm.js')));
  const sessionSettings = lastfmSettings({
    apiKey: credentials.apiKey,
    sharedSecret: credentials.sharedSecret,
    authToken,
  });
  const session = await lastfm.completeLastfmAuth(sessionSettings);
  await lastfm.updateLastfmNowPlaying(lastfmSettings({
    apiKey: credentials.apiKey,
    sharedSecret: credentials.sharedSecret,
    sessionKey: session.sessionKey,
    username: session.username,
  }), lastfmLiveProofTrack);

  const artifactProof = artifactFingerprints(artifacts);
  const missingArtifacts = artifactProof.filter((artifact) => !artifact.exists);
  if (missingArtifacts.length) {
    throw new Error(`Missing release artifacts: ${missingArtifacts.map((artifact) => artifact.name).join(', ')}`);
  }

  const proof = {
    schemaVersion: 1,
    app: 'NewAmp',
    createdAt: new Date().toISOString(),
    platform: process.platform,
    username: session.username,
    credentialSources: credentials.sources,
    authTokenSha256: sha256Text(authToken),
    sessionKeySha256: sha256Text(session.sessionKey),
    nowPlaying: {
      ok: true,
      method: 'track.updateNowPlaying',
      track: lastfmLiveProofTrack,
    },
    artifacts: Object.fromEntries(artifactProof.map((artifact) => [artifact.name, artifact])),
  };
  mkdirSync(dirname(proofPath), { recursive: true });
  writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  return checkLastfmLiveProof({ proofPath, artifacts });
}

export function checkLastfmLiveProof({
  proofPath = defaultLastfmLiveProofPath(),
  artifacts = defaultLastfmLiveProofArtifacts(),
} = {}) {
  const artifactProof = artifactFingerprints(artifacts);
  if (!existsSync(proofPath)) {
    return {
      name: 'lastfm-live-proof',
      ok: false,
      proofPath,
      reason: 'Last.fm live proof file is missing',
      artifacts: artifactProof,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(proofPath, 'utf8'));
  } catch (err) {
    return {
      name: 'lastfm-live-proof',
      ok: false,
      proofPath,
      reason: `Last.fm live proof file is not valid JSON: ${errorMessage(err)}`,
      artifacts: artifactProof,
    };
  }

  const createdAt = typeof parsed?.createdAt === 'string' ? parsed.createdAt : null;
  const createdAtValid = createdAt ? Number.isFinite(Date.parse(createdAt)) : false;
  const username = typeof parsed?.username === 'string' && parsed.username.trim() ? parsed.username.trim() : null;
  const nowPlayingOk = parsed?.nowPlaying?.ok === true && parsed?.nowPlaying?.method === 'track.updateNowPlaying';
  const mismatchedArtifacts = artifactProof.filter((artifact) => {
    const recorded = parsed?.artifacts?.[artifact.name];
    return !artifact.exists || !recorded || recorded.sha256 !== artifact.sha256 || recorded.bytes !== artifact.bytes;
  });
  const hasSecretLeak = JSON.stringify(parsed).includes('lastfmSharedSecret') || JSON.stringify(parsed).includes('sessionKey":');
  const ok = createdAtValid && Boolean(username) && nowPlayingOk && mismatchedArtifacts.length === 0 && !hasSecretLeak;

  return {
    name: 'lastfm-live-proof',
    ok,
    proofPath,
    createdAt,
    username,
    nowPlaying: parsed?.nowPlaying ?? null,
    mismatchedArtifacts: mismatchedArtifacts.map((artifact) => artifact.name),
    artifacts: artifactProof,
    reason: ok
      ? null
      : lastfmProofReason({ createdAtValid, username, nowPlayingOk, mismatchedArtifacts, hasSecretLeak }),
  };
}

export function summarizeLastfmLiveProof(report) {
  if (report.ok) return `Last.fm live proof recorded for ${report.username} at ${report.createdAt}`;
  return report.reason ?? 'Last.fm live proof is missing or invalid';
}

export function resolveLastfmCredentials({ env = process.env, settingsPaths = lastfmSettingsPathCandidates(env) } = {}) {
  const settingsMatch = readFirstLastfmSettings(settingsPaths);
  const settings = settingsMatch?.settings ?? {};
  const values = {
    apiKey: firstText(env.NEWAMP_LASTFM_API_KEY, env.LASTFM_API_KEY, settings.lastfmApiKey),
    sharedSecret: firstText(env.NEWAMP_LASTFM_SHARED_SECRET, env.LASTFM_SHARED_SECRET, settings.lastfmSharedSecret),
  };
  return {
    ...values,
    sources: {
      apiKey: credentialSource(['NEWAMP_LASTFM_API_KEY', 'LASTFM_API_KEY'], env, settings.lastfmApiKey),
      sharedSecret: credentialSource(['NEWAMP_LASTFM_SHARED_SECRET', 'LASTFM_SHARED_SECRET'], env, settings.lastfmSharedSecret),
    },
    settingsPath: settingsMatch?.path ?? null,
    checkedSettingsPaths: settingsPaths,
  };
}

export function lastfmSettingsPathCandidates(env = process.env) {
  const candidates = [];
  if (env.NEWAMP_SETTINGS_PATH) candidates.push(resolve(env.NEWAMP_SETTINGS_PATH));
  if (env.NEWAMP_SMOKE_USER_DATA) candidates.push(resolve(env.NEWAMP_SMOKE_USER_DATA, 'settings.json'));
  if (process.platform === 'win32') {
    if (env.APPDATA) {
      candidates.push(join(env.APPDATA, 'newamp', 'settings.json'));
      candidates.push(join(env.APPDATA, 'NewAmp', 'settings.json'));
      candidates.push(join(env.APPDATA, 'Newamp', 'settings.json'));
    }
    if (env.LOCALAPPDATA) {
      candidates.push(join(env.LOCALAPPDATA, 'newamp', 'settings.json'));
      candidates.push(join(env.LOCALAPPDATA, 'NewAmp', 'settings.json'));
      candidates.push(join(env.LOCALAPPDATA, 'Newamp', 'settings.json'));
    }
  } else {
    const home = env.HOME;
    if (home) {
      candidates.push(join(home, '.config', 'newamp', 'settings.json'));
      candidates.push(join(home, '.config', 'NewAmp', 'settings.json'));
      candidates.push(join(home, '.config', 'Newamp', 'settings.json'));
    }
  }
  return [...new Set(candidates.map((item) => resolve(item)))];
}

function lastfmSettings({ apiKey, sharedSecret, authToken = null, sessionKey = null, username = null }) {
  return {
    libraryRoots: [],
    libraryAutoWatch: false,
    theme: 'classic',
    customSkin: null,
    lastfmEnabled: true,
    lastfmApiKey: apiKey,
    lastfmSharedSecret: sharedSecret,
    lastfmSessionKey: sessionKey,
    lastfmUsername: username,
    lastfmAuthToken: authToken,
    crossfadeMs: 0,
    replayGain: 'off',
    limiterEnabled: true,
    preampDb: 0,
    resumeState: null,
    compactMode: false,
    alwaysOnTop: false,
    volume: 0.75,
    playbackRate: 1,
    audioOutputDeviceId: null,
    autoDjEnabled: false,
    autoDjTarget: 24,
    autoDjSmartRuleId: null,
    visualizerPreset: 'spectrum',
    equalizer: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    eqEnabled: false,
  };
}

function readFirstLastfmSettings(paths) {
  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      if (firstText(parsed.lastfmApiKey, parsed.lastfmSharedSecret)) return { path, settings: parsed };
    } catch {
      continue;
    }
  }
  return null;
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
      sha256: sha256File(artifact.path),
    };
  });
}

function lastfmProofReason({ createdAtValid, username, nowPlayingOk, mismatchedArtifacts, hasSecretLeak }) {
  const parts = [];
  if (!createdAtValid) parts.push('proof timestamp is missing or invalid');
  if (!username) parts.push('proof username is missing');
  if (!nowPlayingOk) parts.push('Now Playing write proof is missing');
  if (mismatchedArtifacts.length) {
    parts.push(`artifact hashes do not match current release files: ${mismatchedArtifacts.map((item) => item.name).join(', ')}`);
  }
  if (hasSecretLeak) parts.push('proof appears to contain a raw Last.fm secret');
  return parts.join('; ') || 'Last.fm live proof is invalid';
}

function credentialSource(names, env, settingsValue) {
  for (const name of names) {
    if (firstText(env[name])) return `env:${name}`;
  }
  return firstText(settingsValue) ? 'app-settings' : 'missing';
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function appVersion(root) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    return String(pkg.version ?? '').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}

function sha256Text(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').toUpperCase();
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function errorMessage(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

function parseCliArgs(argv) {
  const flags = new Set();
  let token = '';
  let proofPath = defaultLastfmLiveProofPath();
  for (const arg of argv) {
    if (arg.startsWith('--token=')) token = arg.slice('--token='.length);
    else if (arg.startsWith('--proof=')) proofPath = resolve(arg.slice('--proof='.length));
    else flags.add(arg);
  }
  return { flags, token, proofPath };
}

function printUsage() {
  console.log([
    'Usage:',
    '  npm run release:start-lastfm-proof',
    '  npm run release:record-lastfm-proof -- --token=<token> --confirm-live-write',
    '  npm run release:check-lastfm-proof',
    '',
    'Credentials are read from NEWAMP_LASTFM_API_KEY and NEWAMP_LASTFM_SHARED_SECRET,',
    'or from saved app settings. The proof file stores hashes only, never the shared secret or session key.',
  ].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const { flags, token, proofPath } = parseCliArgs(process.argv.slice(2));
  try {
    if (flags.has('--start')) {
      console.log(JSON.stringify(await startLastfmLiveProof(), null, 2));
    } else if (flags.has('--record')) {
      const report = await recordLastfmLiveProof({
        token,
        proofPath,
        confirmLiveWrite: flags.has('--confirm-live-write'),
      });
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    } else if (flags.has('--check')) {
      const report = checkLastfmLiveProof({ proofPath });
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
