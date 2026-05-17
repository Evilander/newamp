import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkLastfmLiveProof, lastfmLiveProofTrack, summarizeLastfmLiveProof } from './lastfm-live-proof.mjs';

const repoRoot = resolve('.');
const scriptPath = fileURLToPath(import.meta.url);
const defaultTimeoutMs = Math.max(2000, Number(process.env.NEWAMP_LIVE_SERVICE_TIMEOUT_MS ?? 12000));
const packageVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const newampUserAgent = `NewAmp/${packageVersion}`;

export async function checkLiveServicesReadiness({ timeoutMs = defaultTimeoutMs } = {}) {
  const [ultimateGuitar, lastfm] = await Promise.all([
    maybeCheckUltimateGuitar({ timeoutMs }),
    checkLastfm({ timeoutMs }),
  ]);
  return {
    name: 'live-services-readiness',
    ok: (!ultimateGuitar.required || ultimateGuitar.ok) && lastfm.ok,
    timeoutMs,
    ultimateGuitar,
    lastfm,
  };
}

export function summarizeLiveServices(report) {
  const parts = [];
  if (report.ultimateGuitar?.required && !report.ultimateGuitar?.ok) {
    parts.push(`Ultimate Guitar: ${report.ultimateGuitar?.reason ?? 'not proven'}`);
  }
  if (!report.lastfm?.ok) parts.push(`Last.fm: ${report.lastfm?.reason ?? 'not proven'}`);
  return parts.join('; ') || 'live services are not proven';
}

async function maybeCheckUltimateGuitar({ timeoutMs }) {
  const required = process.env.NEWAMP_REQUIRE_UG_LIVE_PROOF === '1';
  const enabled = required || process.env.NEWAMP_UG_LIVE_PROOF === '1';
  if (!enabled) {
    return {
      ok: true,
      required: false,
      skipped: true,
      reason: 'guitar tabs are optional for this release and are not a live-service gate',
    };
  }
  const report = await checkUltimateGuitar({ timeoutMs });
  return {
    ...report,
    required,
    skipped: false,
  };
}

async function checkUltimateGuitar({ timeoutMs }) {
  const started = Date.now();
  const artist = process.env.NEWAMP_UG_PROBE_ARTIST || 'Radiohead';
  const title = process.env.NEWAMP_UG_PROBE_TITLE || 'Creep';
  try {
    const tabs = await import(pathToFileURL(resolve(repoRoot, 'dist-electron', 'electron', 'guitar-tabs.js')));
    const url = tabs.buildUltimateGuitarSearchUrl({ artist, title, limit: 5 });
    const response = await fetchWithTimeout(url.toString(), {
      timeoutMs,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent':
          `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ${newampUserAgent} Safari/537.36`,
      },
    });
    const body = await response.text();
    const blocked = /Just a moment|Cloudflare|challenge-platform/i.test(body);
    if (!response.ok || blocked) {
      return {
        ok: false,
        status: response.status,
        elapsedMs: Date.now() - started,
        probe: { artist, title, url: url.toString() },
        reason: blocked || response.status === 403
          ? 'blocked by Cloudflare/anti-automation from this network'
          : `request failed with HTTP ${response.status}`,
      };
    }
    const results = tabs.parseUltimateGuitarSearchHtml(body);
    return {
      ok: results.length > 0,
      status: response.status,
      elapsedMs: Date.now() - started,
      probe: { artist, title, url: url.toString() },
      results: results.slice(0, 5).map((item) => ({
        artist: item.artist,
        title: item.title,
        kind: item.kind,
        rating: item.rating,
        votes: item.votes,
        url: item.url,
      })),
      reason: results.length > 0 ? null : 'search page loaded but no tab results were parsed',
    };
  } catch (err) {
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      probe: { artist, title },
      reason: errorMessage(err),
    };
  }
}

async function checkLastfm({ timeoutMs }) {
  const started = Date.now();
  const credentials = resolveLastfmCredentials();
  const { apiKey, sharedSecret, sessionKey, username } = credentials;
  const liveWrite = process.env.NEWAMP_LASTFM_LIVE_WRITE === '1';
  const env = {
    hasApiKey: Boolean(apiKey),
    hasSharedSecret: Boolean(sharedSecret),
    hasSessionKey: Boolean(sessionKey),
    hasUsername: Boolean(username),
    liveWriteEnabled: liveWrite,
    sources: credentials.sources,
    settingsPath: credentials.settingsPath,
    checkedSettingsPaths: credentials.checkedSettingsPaths,
  };
  if (!apiKey || !sharedSecret) {
    const liveProof = checkLastfmLiveProof();
    if (liveProof.ok) {
      return {
        ok: true,
        elapsedMs: Date.now() - started,
        env,
        authTokenProbe: null,
        accountProbe: { ok: true, mode: 'recorded-proof', proofPath: liveProof.proofPath },
        liveProof,
        reason: null,
      };
    }
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      env,
      authTokenProbe: null,
      accountProbe: null,
      liveProof,
      reason: 'missing Last.fm API key/shared secret in env or saved app settings',
    };
  }

  try {
    const lastfm = await import(pathToFileURL(resolve(repoRoot, 'dist-electron', 'electron', 'lastfm.js')));
    const authTokenProbe = await withTimeout(
      lastfm.startLastfmAuth(lastfmSettings({ apiKey, sharedSecret, sessionKey, username })),
      timeoutMs,
      'Last.fm auth token probe timed out',
    );
    let accountProbe = null;
    if (sessionKey && liveWrite) {
      await withTimeout(
        lastfm.updateLastfmNowPlaying(
          lastfmSettings({ apiKey, sharedSecret, sessionKey, username }),
          lastfmLiveProofTrack,
        ),
        timeoutMs,
        'Last.fm account write probe timed out',
      );
      accountProbe = { ok: true, mode: 'track.updateNowPlaying' };
    } else {
      const liveProof = checkLastfmLiveProof();
      if (liveProof.ok) {
        accountProbe = { ok: true, mode: 'recorded-proof', proofPath: liveProof.proofPath };
        return {
          ok: Boolean(authTokenProbe?.token),
          elapsedMs: Date.now() - started,
          env,
          authTokenProbe: { ok: Boolean(authTokenProbe?.token), authUrlPresent: Boolean(authTokenProbe?.authUrl) },
          accountProbe,
          liveProof,
          reason: null,
        };
      }
      accountProbe = {
        ok: false,
        mode: 'skipped',
        reason: sessionKey
          ? 'session key is present but NEWAMP_LASTFM_LIVE_WRITE=1 is required for the non-permanent now-playing write probe'
          : 'missing Last.fm session key in env or saved app settings',
        liveProof: summarizeLastfmLiveProof(liveProof),
      };
    }
    return {
      ok: Boolean(authTokenProbe?.token) && accountProbe.ok,
      elapsedMs: Date.now() - started,
      env,
      authTokenProbe: { ok: Boolean(authTokenProbe?.token), authUrlPresent: Boolean(authTokenProbe?.authUrl) },
      accountProbe,
      liveProof: checkLastfmLiveProof(),
      reason: accountProbe.ok ? null : accountProbe.reason,
    };
  } catch (err) {
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      env,
      authTokenProbe: null,
      accountProbe: null,
      reason: errorMessage(err),
    };
  }
}

function lastfmSettings({ apiKey, sharedSecret, sessionKey, username }) {
  return {
    libraryRoots: [],
    libraryAutoWatch: false,
    theme: 'classic',
    customSkin: null,
    lastfmEnabled: true,
    lastfmApiKey: apiKey,
    lastfmSharedSecret: sharedSecret,
    lastfmSessionKey: sessionKey || null,
    lastfmUsername: username || null,
    lastfmAuthToken: null,
    crossfadeMs: 0,
    replayGain: 'off',
    limiterEnabled: true,
    preampDb: 0,
    resumeState: null,
    volume: 0.75,
    playbackRate: 1,
    audioOutputDeviceId: null,
    autoDjEnabled: false,
    autoDjTarget: 24,
    autoDjSmartRuleId: null,
    equalizer: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    eqEnabled: false,
  };
}

export function resolveLastfmCredentials({ env = process.env, settingsPaths = lastfmSettingsPathCandidates(env) } = {}) {
  const settingsMatch = readFirstLastfmSettings(settingsPaths);
  const settings = settingsMatch?.settings ?? {};
  const values = {
    apiKey: firstText(env.NEWAMP_LASTFM_API_KEY, env.LASTFM_API_KEY, settings.lastfmApiKey),
    sharedSecret: firstText(env.NEWAMP_LASTFM_SHARED_SECRET, env.LASTFM_SHARED_SECRET, settings.lastfmSharedSecret),
    sessionKey: firstText(env.NEWAMP_LASTFM_SESSION_KEY, env.LASTFM_SESSION_KEY, settings.lastfmSessionKey),
    username: firstText(env.NEWAMP_LASTFM_USERNAME, env.LASTFM_USERNAME, settings.lastfmUsername),
  };
  return {
    ...values,
    sources: {
      apiKey: credentialSource(['NEWAMP_LASTFM_API_KEY', 'LASTFM_API_KEY'], env, settings.lastfmApiKey),
      sharedSecret: credentialSource(['NEWAMP_LASTFM_SHARED_SECRET', 'LASTFM_SHARED_SECRET'], env, settings.lastfmSharedSecret),
      sessionKey: credentialSource(['NEWAMP_LASTFM_SESSION_KEY', 'LASTFM_SESSION_KEY'], env, settings.lastfmSessionKey),
      username: credentialSource(['NEWAMP_LASTFM_USERNAME', 'LASTFM_USERNAME'], env, settings.lastfmUsername),
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

function readFirstLastfmSettings(paths) {
  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      if (
        firstText(parsed.lastfmApiKey, parsed.lastfmSharedSecret, parsed.lastfmSessionKey, parsed.lastfmUsername)
      ) {
        return { path, settings: parsed };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function credentialSource(envNames, env, settingsValue) {
  for (const name of envNames) {
    if (firstText(env[name])) return `env:${name}`;
  }
  return firstText(settingsValue) ? 'app-settings' : 'missing';
}

async function fetchWithTimeout(url, { timeoutMs, headers }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ]);
}

function errorMessage(err) {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'request timed out';
    return err.message;
  }
  return String(err);
}

if (process.argv[1] && process.argv[1].replaceAll('\\', '/').toLowerCase() === scriptPath.replaceAll('\\', '/').toLowerCase()) {
  const report = await checkLiveServicesReadiness();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
