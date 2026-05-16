import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  buildLastfmTrackParams,
  LastfmApiError,
  LastfmScrobbleOutbox,
  shouldScrobble,
  shouldRetryLastfmError,
  signLastfmParams,
} = await import('../dist-electron/electron/lastfm.js');
const { resolveLastfmCredentials } = await import('./live-services-readiness-smoke.mjs');

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outboxRoot = join(repoRoot, 'tmp', 'lastfm-outbox-smoke');
const outboxPath = join(outboxRoot, 'scrobbles.json');

const expectedSig = createHash('md5')
  .update('api_keyxxxxxxxxmethodauth.getSessiontokenxxxxxxxmysecret')
  .digest('hex');

assert.equal(
  signLastfmParams({
    api_key: 'xxxxxxxx',
    method: 'auth.getSession',
    token: 'xxxxxxx',
  }, 'mysecret'),
  expectedSig,
  'Last.fm signature should sort params and append the shared secret',
);

assert.deepEqual(
  buildLastfmTrackParams({
    artist: 'Radiohead',
    title: 'Paranoid Android',
    album: 'OK Computer',
    albumArtist: 'Radiohead',
    duration: 383.4,
    trackNumber: 2,
  }),
  {
    artist: 'Radiohead',
    track: 'Paranoid Android',
    album: 'OK Computer',
    albumArtist: 'Radiohead',
    duration: '383',
    trackNumber: '2',
  },
  'track params should map Newamp metadata to Last.fm names',
);

assert.equal(shouldScrobble({ duration: 29, currentTime: 29 }), false);
assert.equal(shouldScrobble({ duration: 180, currentTime: 89 }), false);
assert.equal(shouldScrobble({ duration: 180, currentTime: 90 }), true);
assert.equal(shouldScrobble({ duration: 600, currentTime: 239 }), false);
assert.equal(shouldScrobble({ duration: 600, currentTime: 240 }), true);

await rm(outboxRoot, { recursive: true, force: true });
await mkdir(outboxRoot, { recursive: true });
const outbox = new LastfmScrobbleOutbox(outboxPath);
const cachedTrack = {
  artist: 'Radiohead',
  title: 'No Surprises',
  album: 'OK Computer',
  albumArtist: 'Radiohead',
  duration: 229,
  trackNumber: 10,
};
await outbox.enqueue(cachedTrack, 1778800000, 'network offline');
assert.equal((await outbox.list()).length, 1, 'failed scrobble should persist to disk');

let attempts = 0;
const failedFlush = await outbox.flush(async () => {
  attempts += 1;
  throw new Error('still offline');
});
assert.equal(attempts, 1, 'outbox should try the first cached scrobble');
assert.equal(failedFlush.sent, 0);
assert.equal(failedFlush.remaining, 1);
assert.equal((await outbox.list())[0]?.attempts, 1, 'failed flush should increment attempts');

const sent = [];
const successfulFlush = await outbox.flush(async (item) => {
  sent.push(`${item.track.artist} - ${item.track.title}`);
});
assert.deepEqual(sent, ['Radiohead - No Surprises']);
assert.equal(successfulFlush.sent, 1);
assert.equal(successfulFlush.remaining, 0);
assert.deepEqual(await outbox.list(), [], 'successful flush should clear sent scrobbles');

await outbox.enqueue({
  artist: 'Local Demo',
  title: 'Private Recording',
  album: 'Home Demos',
  albumArtist: 'Local Demo',
  duration: 193,
  trackNumber: 1,
}, 1778800100, null);
const nonRetryableFlush = await outbox.flush(async () => {
  throw new LastfmApiError('Invalid parameters - track metadata was filtered', { code: 6, status: 400 });
});
assert.equal(nonRetryableFlush.remaining, 0, 'permanent Last.fm metadata failures should not stay queued forever');
assert.deepEqual(await outbox.list(), [], 'non-retryable Last.fm failures should be dropped from the retry outbox');
assert.equal(shouldRetryLastfmError(new LastfmApiError('Service unavailable', { code: 16, status: 503 })), true);
assert.equal(shouldRetryLastfmError(new LastfmApiError('Invalid parameters', { code: 6, status: 400 })), false);
assert.equal(shouldRetryLastfmError(new Error('network offline')), true);

const settingsRoot = join(repoRoot, 'tmp', 'lastfm-settings-smoke');
const settingsPath = join(settingsRoot, 'settings.json');
await rm(settingsRoot, { recursive: true, force: true });
await mkdir(settingsRoot, { recursive: true });
await writeFile(settingsPath, JSON.stringify({
  lastfmApiKey: 'settings-api-key',
  lastfmSharedSecret: 'settings-secret',
  lastfmSessionKey: 'settings-session',
  lastfmUsername: 'settings-user',
}), 'utf8');

const settingsCredentials = resolveLastfmCredentials({ env: {}, settingsPaths: [settingsPath] });
assert.equal(settingsCredentials.apiKey, 'settings-api-key');
assert.equal(settingsCredentials.sharedSecret, 'settings-secret');
assert.equal(settingsCredentials.sessionKey, 'settings-session');
assert.equal(settingsCredentials.username, 'settings-user');
assert.equal(settingsCredentials.sources.apiKey, 'app-settings');
assert.equal(settingsCredentials.settingsPath, settingsPath);

const mixedCredentials = resolveLastfmCredentials({
  env: { NEWAMP_LASTFM_SESSION_KEY: 'env-session' },
  settingsPaths: [settingsPath],
});
assert.equal(mixedCredentials.apiKey, 'settings-api-key');
assert.equal(mixedCredentials.sessionKey, 'env-session');
assert.equal(mixedCredentials.sources.sessionKey, 'env:NEWAMP_LASTFM_SESSION_KEY');

const [settingsView, storeSource, sharedTypes, liveServicesSource] = await Promise.all([
  readFile(new URL('../src/components/views/SettingsView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('./live-services-readiness-smoke.mjs', import.meta.url), 'utf8'),
]);

assert.match(settingsView, /Last\.fm/, 'Settings should expose Last.fm connection controls');
assert.match(settingsView, /lastfmStartAuth/, 'Settings should start the desktop auth flow');
assert.match(settingsView, /testLastfmNowPlaying/, 'Settings should expose a Last.fm now-playing proof action');
assert.match(settingsView, /Test now playing/, 'Settings should label the Last.fm proof action clearly');
assert.match(storeSource, /lastfmUpdateNowPlaying/, 'Player store should send Now Playing updates');
assert.match(storeSource, /lastfmScrobble/, 'Player store should scrobble after the Last.fm play threshold');
assert.match(sharedTypes, /LastfmOutboxStatus/, 'API should expose Last.fm outbox status');
assert.match(sharedTypes, /lastfmApiKey/, 'Settings should store a user-provided Last.fm API key');
assert.match(sharedTypes, /lastfmSharedSecret/, 'Settings should store a user-provided Last.fm shared secret');
assert.match(liveServicesSource, /NEWAMP_SETTINGS_PATH/, 'Live-service proof should accept an explicit settings path');
assert.match(liveServicesSource, /app-settings/, 'Live-service proof should report saved app settings as a credential source');

console.log(JSON.stringify({
  ok: true,
  signature: expectedSig,
  outbox: {
    sent: successfulFlush.sent,
    remaining: successfulFlush.remaining,
  },
  thresholds: {
    halfOfThreeMinutes: 90,
    fourMinuteCap: 240,
  },
}, null, 2));
