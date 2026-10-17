// Test media and an isolated profile for scripts/mac-verify.mjs. Three short
// quiet tones (MP3, FLAC and Apple Lossless in .m4a) in one album folder with a
// cover image, plus a settings.json that points the app at that folder only,
// so nothing of the person's own library or settings is read or written.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const FIXTURE_ALBUM = { artist: 'Mac Verify', album: 'Fixture Album', year: 2026, genre: 'Test' };

export const FIXTURE_TRACKS = [
  { n: 1, title: 'Verify One', file: '01 - Verify One.mp3', codec: 'mp3', hz: 440, args: ['-c:a', 'libmp3lame', '-q:a', '5'] },
  { n: 2, title: 'Verify Two', file: '02 - Verify Two.flac', codec: 'flac', hz: 523, args: ['-c:a', 'flac', '-sample_fmt', 's16'] },
  { n: 3, title: 'Verify Three', file: '03 - Verify Three.m4a', codec: 'alac', hz: 659, args: ['-c:a', 'alac'] },
];

/**
 * ffmpeg-static from the repo's node_modules, then the one bundled in a
 * packaged app, then whatever is on PATH.
 */
export function resolveFfmpeg({ repoRoot, appPath }) {
  try {
    const installed = createRequire(join(repoRoot, 'package.json'))('ffmpeg-static');
    if (installed && existsSync(installed)) return installed;
  } catch {
    /* not installed in the repo */
  }
  const bundled = appPath && join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg');
  if (bundled && existsSync(bundled)) return bundled;
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return probe.status === 0 ? 'ffmpeg' : null;
}

function ffmpeg(binary, args) {
  const result = spawnSync(binary, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg failed (${result.status}): ${result.stderr || result.stdout}`);
}

/**
 * Builds <root>/media and <root>/user-data. The sine source is -18 dBFS and
 * the app volume is set low, so playback is audible to Chromium's detector
 * (which the checks use to tell that sound is still being produced) and barely
 * so to a person in the room. The slider position is tapered cubically below
 * unity (volumePositionToGain), so 0.3 is -31 dB: about -49 dBFS at the
 * output, above the detector's silence floor (around -72 dBFS) and quiet.
 * 0.05 would be -78 dB, which the detector counts as silence.
 */
export async function prepareFixtures({ root, binary, seconds = 40, volume = 0.3 }) {
  await rm(root, { recursive: true, force: true });
  const mediaDir = join(root, 'media', 'Mac Verify - Fixture Album');
  const userData = join(root, 'user-data');
  const sessionData = join(root, 'session-data');
  await mkdir(mediaDir, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(sessionData, { recursive: true });

  ffmpeg(binary, ['-f', 'lavfi', '-i', 'color=c=0x2a5a8a:s=600x600', '-frames:v', '1', join(mediaDir, 'cover.jpg')]);
  for (const track of FIXTURE_TRACKS) {
    ffmpeg(binary, [
      '-f', 'lavfi', '-i', `sine=frequency=${track.hz}:sample_rate=44100:duration=${seconds}`,
      '-ac', '2',
      '-metadata', `title=${track.title}`,
      '-metadata', `artist=${FIXTURE_ALBUM.artist}`,
      '-metadata', `album=${FIXTURE_ALBUM.album}`,
      '-metadata', `album_artist=${FIXTURE_ALBUM.artist}`,
      '-metadata', `track=${track.n}`,
      '-metadata', `date=${FIXTURE_ALBUM.year}`,
      '-metadata', `genre=${FIXTURE_ALBUM.genre}`,
      ...track.args,
      join(mediaDir, track.file),
    ]);
  }
  await writeSettings(userData, join(root, 'media'), { volume });
  return { root, mediaDir, libraryRoot: join(root, 'media'), userData, sessionData, tracks: FIXTURE_TRACKS };
}

export async function writeSettings(userData, libraryRoot, overrides = {}) {
  const settings = {
    libraryRoots: [libraryRoot],
    libraryAutoWatch: false,
    theme: 'classic',
    customSkin: null,
    lastfmEnabled: false,
    lastfmApiKey: null,
    lastfmSharedSecret: null,
    lastfmSessionKey: null,
    lastfmUsername: null,
    lastfmAuthToken: null,
    openaiApiKey: null,
    firstLaunchTutorialSeen: true,
    textScale: 1,
    crossfadeMs: 0,
    replayGain: 'off',
    limiterEnabled: true,
    preampDb: 0,
    resumeState: null,
    compactMode: false,
    alwaysOnTop: false,
    volume: 0.3,
    playbackRate: 1,
    audioOutputDeviceId: null,
    autoDjEnabled: false,
    equalizer: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    eqEnabled: false,
    closeButtonBehavior: 'minimize-to-tray',
    ...overrides,
  };
  await writeFile(join(userData, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
}
