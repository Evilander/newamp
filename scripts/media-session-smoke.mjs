import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildMediaSessionMetadata,
  mediaSessionPlaybackState,
  mediaSessionPositionNeedsSync,
  mediaSessionPositionState,
} from '../dist-electron/shared/media-session.js';

const track = {
  id: 7,
  title: 'Windowlicker',
  artist: 'Aphex Twin',
  album: 'Windowlicker',
  albumArtist: 'Aphex Twin',
  trackNo: 1,
  discNo: null,
  year: 1999,
  genre: 'Electronic',
  duration: 367,
  bitrate: null,
  sampleRate: null,
  size: null,
  mtime: 1000,
  hasArt: 1,
  loved: 0,
  rating: 0,
  playCount: 0,
  lastPlayed: null,
  skipCount: 0,
  lastSkipped: null,
  bpm: null,
  key: null,
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  path: 'K:/music/aphex-twin/windowlicker.mp3',
};

const metadata = buildMediaSessionMetadata(track, 'newart://track/7/art');
assert.equal(metadata.title, 'Windowlicker');
assert.equal(metadata.artist, 'Aphex Twin');
assert.equal(metadata.album, 'Windowlicker');
assert.deepEqual(metadata.artwork, [
  { src: 'newart://track/7/art', sizes: '512x512', type: 'image/jpeg' },
]);

// OS position pushes: only when the OS's own extrapolation would be wrong.
const snap = { trackId: 7, duration: 367, position: 40, playbackRate: 1, playing: true, atMs: 10_000 };
assert.equal(mediaSessionPositionNeedsSync(null, snap), true, 'first state is always pushed');
assert.equal(
  mediaSessionPositionNeedsSync(snap, { ...snap, position: 42, atMs: 12_000 }),
  false,
  'steady playback is extrapolated by the OS',
);
assert.equal(
  mediaSessionPositionNeedsSync(snap, { ...snap, position: 120, atMs: 12_000 }),
  true,
  'a seek is pushed',
);
assert.equal(mediaSessionPositionNeedsSync(snap, { ...snap, playing: false }), true, 'pause is pushed');
assert.equal(mediaSessionPositionNeedsSync(snap, { ...snap, trackId: 8 }), true, 'track change is pushed');
assert.equal(mediaSessionPositionNeedsSync(snap, { ...snap, playbackRate: 1.25 }), true, 'rate change is pushed');
// duration is NaN until a track's metadata lands. NaN !== NaN, so a plain
// comparison would report a change on every tick through that window.
const unknownDuration = { ...snap, duration: Number.NaN };
assert.equal(
  mediaSessionPositionNeedsSync(unknownDuration, { ...unknownDuration, position: 42, atMs: 12_000 }),
  false,
  'an unknown duration on both sides is not a change',
);
assert.equal(
  mediaSessionPositionNeedsSync(unknownDuration, { ...unknownDuration, duration: 367 }),
  true,
  'a duration arriving is pushed',
);
const pausedSnap = { ...snap, playing: false };
assert.equal(
  mediaSessionPositionNeedsSync(pausedSnap, { ...pausedSnap, atMs: 60_000 }),
  false,
  'a paused playhead does not drift',
);

assert.equal(mediaSessionPlaybackState(true, track), 'playing');
assert.equal(mediaSessionPlaybackState(false, track), 'paused');
assert.equal(mediaSessionPlaybackState(true, null), 'none');
assert.deepEqual(mediaSessionPositionState({ duration: 367, currentTime: 42.8, playbackRate: 1.25 }), {
  duration: 367,
  position: 42.8,
  playbackRate: 1.25,
});
assert.equal(
  mediaSessionPositionState({ duration: 0, currentTime: 42.8, playbackRate: 1 }),
  null,
  'position state should be omitted without a usable duration',
);

const [appSource, mediaSessionSource, packageSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/mediaSession.ts', import.meta.url), 'utf8'),
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
]);

assert.match(appSource, /syncMediaSession/, 'App should synchronize browser media session metadata');
assert.match(mediaSessionSource, /navigator\.mediaSession/, 'renderer media session helper should use navigator.mediaSession');
for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'stop', 'seekto']) {
  assert.match(mediaSessionSource, new RegExp(`'${action}'`), `media session should handle ${action}`);
}
assert.match(mediaSessionSource, /setActionHandler/, 'media session should register OS action handlers');
assert.match(mediaSessionSource, /MediaMetadata/, 'media session should publish title, artist, album, and artwork');
assert.match(packageSource, /smoke:media-session/, 'package scripts should include media-session smoke');

console.log(JSON.stringify({ ok: true, metadata }, null, 2));
