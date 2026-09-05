// Server queue resume must persist only credential-free descriptors and restore
// mixed local/remote order from remembered connections. Run:
// node scripts/server-queue-resume-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const outDir = resolve('tmp/server-queue-resume-test');
mkdirSync(outDir, { recursive: true });

globalThis.window = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  location: { search: '' },
  winctl: { notifyPlayback: () => undefined },
};

await build({
  entryPoints: [
    resolve('src/store/usePlayerStore.ts'),
    resolve('electron/settings.ts'),
  ],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outdir: outDir,
  define: { 'import.meta.env.DEV': 'false' },
  logLevel: 'silent',
});

const storeModule = await import(pathToFileURL(resolve(outDir, 'src/store/usePlayerStore.js')).href);
const settingsModule = await import(pathToFileURL(resolve(outDir, 'electron/settings.js')).href);

const {
  playbackResumeQueueEntryForTrack,
  playbackResumeStateForQueueSnapshot,
  restoreTracksFromPlaybackResumeState,
  shouldForcePlaybackSessionPersist,
} = storeModule;
const { SettingsStore } = settingsModule;

assert.equal(typeof playbackResumeQueueEntryForTrack, 'function');
assert.equal(typeof playbackResumeStateForQueueSnapshot, 'function');
assert.equal(typeof restoreTracksFromPlaybackResumeState, 'function');
assert.equal(typeof shouldForcePlaybackSessionPersist, 'function');

function localTrack(id) {
  return {
    id,
    path: `K:/music/local-${id}.flac`,
    title: `Local ${id}`,
    artist: 'Local Artist',
    album: 'Local Album',
    albumArtist: 'Local Artist',
    trackNo: null,
    discNo: null,
    year: null,
    genre: null,
    duration: 180,
    bitrate: 900000,
    sampleRate: 44100,
    size: 20_000_000,
    mtime: 123,
    hasArt: 1,
    loved: 1,
    rating: 4,
    ratingScore: 82.5,
    avoidAutoPlay: 0,
    playCount: 7,
    lastPlayed: 456,
    skipCount: 1,
    lastSkipped: 789,
    bpm: 96.5,
    key: '8A',
    replayGainTrackDb: -4.25,
    replayGainAlbumDb: -3.5,
  };
}

function serverTrack({ id, connectionId = 'remembered', itemId = 'album/track 1', path } = {}) {
  return {
    ...localTrack(id),
    id,
    path: path ?? `newamp://server/${encodeURIComponent(connectionId)}/${encodeURIComponent(itemId)}/Remote%20One.flac`,
    title: 'Remote One',
    artist: 'Remote Artist',
    album: 'Remote Album',
    albumArtist: 'Remote Album Artist',
    duration: 245.5,
    bitrate: 1411000,
    sampleRate: 48000,
    size: 43_000_000,
    mtime: 0,
    hasArt: 0,
    loved: 0,
    rating: 0,
    ratingScore: null,
    avoidAutoPlay: 0,
    playCount: 0,
    lastPlayed: null,
    skipCount: 0,
    lastSkipped: null,
    bpm: null,
    key: null,
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
  };
}

const local = localTrack(11);
const remote = serverTrack({ id: -123456 });
const arbitraryPathRemote = serverTrack({
  id: -987,
  connectionId: 'remembered',
  itemId: 'secret',
  path: 'file:///C:/Users/evela/Music/secret.flac',
});

assert.deepEqual(playbackResumeQueueEntryForTrack(local), { kind: 'local', trackId: 11 });
assert.equal(
  playbackResumeQueueEntryForTrack(arbitraryPathRemote),
  null,
  'negative server IDs must not let an arbitrary saved path become a restored track',
);
assert.equal(
  shouldForcePlaybackSessionPersist(
    { currentTrackId: -123456, currentTime: 6, isPlaying: true },
    { currentTrackId: -123456, currentTime: 6, isPlaying: false },
  ),
  true,
  'pause must force a resume persist even inside the normal playing autosave throttle window',
);
assert.equal(
  shouldForcePlaybackSessionPersist(
    { currentTrackId: -123456, currentTime: 0, isPlaying: false },
    { currentTrackId: -123456, currentTime: 6, isPlaying: false },
  ),
  true,
  'seeking while paused must force a resume persist because no later playing tick may arrive',
);
assert.equal(
  shouldForcePlaybackSessionPersist(
    { currentTrackId: -123456, currentTime: 0, isPlaying: true },
    { currentTrackId: -123456, currentTime: 6, isPlaying: true },
  ),
  false,
  'ordinary playing progress should stay on the coalesced 3s autosave path',
);
assert.equal(
  shouldForcePlaybackSessionPersist(
    { currentTrackId: -123456, currentTime: 6, isPlaying: false },
    { currentTrackId: -654321, currentTime: 0, isPlaying: false },
  ),
  false,
  'track changes are already covered by queue/current commits and should not be classified as paused seeks',
);

const storeSource = await readFile(new URL('../src/store/usePlayerStore.ts', import.meta.url), 'utf8');
assert.match(
  storeSource,
  /schedulePersistPlaybackSession\(get\(\), forceSessionPersist\)/,
  'engine playback updates should force resume persistence on pause/paused-seek transitions',
);
assert.match(
  storeSource,
  /if \(!state\.isPlaying\) schedulePersistPlaybackSession\(get\(\), true\);/,
  'manual seeks while already paused should bypass the 3s resume autosave throttle',
);

const resume = playbackResumeStateForQueueSnapshot({
  queue: [local, remote, arbitraryPathRemote],
  index: 1,
  current: remote,
  currentTime: 42.5,
  mode: 'shuffle-repeat-all',
  updatedAt: 1234,
});

assert.deepEqual(resume.queueTrackIds, [11, -123456], 'local+server track IDs should persist in queue order');
assert.equal(resume.index, 1);
assert.equal(resume.currentTrackId, -123456);
assert.equal(resume.currentTime, 42.5);
assert.equal(resume.mode, 'shuffle-repeat-all');
assert.equal(resume.updatedAt, 1234);
assert.equal(resume.queue.length, 2);
assert.deepEqual(resume.queue[0], { kind: 'local', trackId: 11 });
assert.equal(resume.queue[1].kind, 'music-server');
assert.equal(resume.queue[1].connectionId, 'remembered');
assert.equal(resume.queue[1].itemId, 'album/track 1');
assert.equal(resume.queue[1].track.id, -123456);
assert.equal(resume.queue[1].track.path, remote.path);
assert.equal(resume.queue[1].track.title, 'Remote One');
assert.deepEqual(
  Object.keys(resume.queue[1].track).sort(),
  [
    'album',
    'albumArtist',
    'artist',
    'bitrate',
    'discNo',
    'duration',
    'genre',
    'id',
    'path',
    'sampleRate',
    'size',
    'title',
    'trackNo',
    'year',
  ],
  'server resume descriptors should avoid user stats and secrets',
);

const descriptorJson = JSON.stringify(resume);
assert.doesNotMatch(descriptorJson, /baseUrl|username|password|accessToken|serverName|http:|https:/i);

const dir = mkdtempSync(join(tmpdir(), 'newamp-server-resume-'));
try {
  const settings = new SettingsStore(join(dir, 'settings.json'));
  settings.set({ resumeState: resume });
  const normalized = settings.get().resumeState;
  assert.deepEqual(normalized.queueTrackIds, [11, -123456], 'settings must not drop negative server IDs');
  assert.equal(normalized.currentTrackId, -123456, 'settings must keep a server currentTrackId when it belongs to the queue');
  assert.equal(normalized.queue[1].kind, 'music-server');

  settings.set({
    resumeState: {
      ...resume,
      queueTrackIds: [-987],
      queue: [{
        kind: 'music-server',
        connectionId: 'remembered',
        itemId: 'secret',
        track: {
          id: -987,
          path: 'file:///C:/Users/evela/Music/secret.flac',
          title: 'Secret',
          artist: 'Secret',
          album: 'Secret',
          albumArtist: 'Secret',
          trackNo: null,
          discNo: null,
          year: null,
          genre: null,
          duration: null,
          bitrate: null,
          sampleRate: null,
          size: null,
        },
      }],
      index: 0,
      currentTrackId: -987,
    },
  });
  assert.equal(settings.get().resumeState, null, 'settings must reject crafted negative IDs with arbitrary paths');

  const restored = restoreTracksFromPlaybackResumeState(normalized, [local], [
    { id: 'remembered', remembered: true },
  ]);
  assert.deepEqual(restored.savedIds, [11, -123456]);
  assert.deepEqual(restored.tracks.map((track) => track.id), [11, -123456]);
  assert.equal(restored.tracks[1].path, remote.path);
  assert.equal(restored.tracks[1].title, 'Remote One');
  assert.equal(restored.tracks[1].playCount, 0);
  assert.equal(restored.tracks[1].replayGainTrackDb, null);

  const unavailable = restoreTracksFromPlaybackResumeState(normalized, [local], []);
  assert.deepEqual(unavailable.savedIds, [11, -123456]);
  assert.deepEqual(
    unavailable.tracks.map((track) => track.id),
    [11],
    'server descriptors should restore only when their remembered connection is available',
  );

  const sessionOnly = restoreTracksFromPlaybackResumeState(normalized, [local], [
    { id: 'remembered', remembered: false },
  ]);
  assert.deepEqual(
    sessionOnly.tracks.map((track) => track.id),
    [11],
    'session-only connections are not restart credentials and must not rehydrate saved server queue entries',
  );
  settings.flushSync();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('[server-queue-resume-test] PASS');
