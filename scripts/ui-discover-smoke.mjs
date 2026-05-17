import assert from 'node:assert/strict';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LibraryStore } from '../dist-electron/electron/library.js';

const appRoot = resolve('.');
const smokeRoot = resolve('tmp', 'ui-discover-smoke');
const userData = join(smokeRoot, 'user-data');
const mediaDir = join(smokeRoot, 'media');
const marker = '[newamp-ui-discover-smoke] ';

await resetSmokeRoot();
await seedLibrary();
await writeSmokeSettings();

const result = await runElectronSmoke();
assert.equal(result.ok, true, 'UI Discover smoke should report success');
assert.ok(result.missionCount >= 1, 'Discover should render at least one mission');
assert.ok(result.trackRows >= 1, 'Discover should render playable track rows');
assert.equal(result.hasSave, true, 'Discover should expose Save as Playlist');
assert.equal(result.hasStepAction, true, 'Discover should expose mission step actions');
assert.equal(result.hasFullVisualizer, true, 'Discover should expose Full Vis');
assert.equal(result.hasDeck, true, 'Discover should expose Deck');
assert.match(result.missionText, /Daily Crate|Visual Night|Album Session/, 'Discover mission text should describe a Living Library mission');
console.log(JSON.stringify(result, null, 2));

async function resetSmokeRoot() {
  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(mediaDir, { recursive: true });
  await mkdir(userData, { recursive: true });
}

async function seedLibrary() {
  const now = Date.UTC(2026, 4, 17, 12, 0, 0);
  const fixtures = [
    { title: 'Discover Fresh One', artist: 'Discover QA', album: 'Fresh Stack', year: 2026, genre: 'Indie', mtime: now - 1000, plays: 0, rating: 0 },
    { title: 'Discover Fresh Two', artist: 'Discover QA', album: 'Fresh Stack', year: 2026, genre: 'Indie', mtime: now - 2000, plays: 0, rating: 0 },
    { title: 'Discover Loved One', artist: 'Memory Signal', album: 'Recovered Favorites', year: 2015, genre: 'Dream Pop', mtime: now - 8000000, plays: 4, rating: 5, loved: true },
    { title: 'Discover Loved Two', artist: 'Memory Signal', album: 'Recovered Favorites', year: 2015, genre: 'Dream Pop', mtime: now - 8010000, plays: 3, rating: 5, loved: true },
    { title: 'Discover Album A', artist: 'Album Mission', album: 'Whole Path', year: 2008, genre: 'Electronic', mtime: now - 7000000, plays: 0, rating: 4 },
    { title: 'Discover Album B', artist: 'Album Mission', album: 'Whole Path', year: 2008, genre: 'Electronic', mtime: now - 7010000, plays: 0, rating: 4 },
    { title: 'Discover Album C', artist: 'Album Mission', album: 'Whole Path', year: 2008, genre: 'Electronic', mtime: now - 7020000, plays: 0, rating: 3 },
    { title: 'Discover Odd Shelf', artist: 'Private Recording', album: 'Basement Reel', year: 1999, genre: 'Home Recording', mtime: now - 6000000, plays: 0, rating: 0 },
  ];
  for (const fixture of fixtures) {
    await writeFile(join(mediaDir, `${fixture.title}.mp3`), '');
  }

  const library = await LibraryStore.open(join(userData, 'library.db'));
  try {
    library.upsertTracks(fixtures.map((fixture, index) => ({
      path: join(mediaDir, `${fixture.title}.mp3`),
      title: fixture.title,
      artist: fixture.artist,
      album: fixture.album,
      albumArtist: fixture.artist,
      trackNo: index + 1,
      discNo: null,
      year: fixture.year,
      genre: fixture.genre,
      duration: 180 + index,
      bitrate: 320000,
      sampleRate: 44100,
      bpm: null,
      key: null,
      replayGainTrackDb: null,
      replayGainAlbumDb: null,
      size: 1000 + index,
      mtime: fixture.mtime,
      art: null,
    })));

    const tracks = library.getTracks({ sort: 'album', limit: 50 });
    const byTitle = new Map(tracks.map((track) => [track.title, track]));
    for (const fixture of fixtures) {
      const track = byTitle.get(fixture.title);
      if (!track) continue;
      if (fixture.loved) library.toggleLove(track.id);
      if (fixture.rating) library.setTrackRating(track.id, fixture.rating);
      for (let i = 0; i < fixture.plays; i += 1) {
        library.recordPlay(track.id, now - (90 + i) * 24 * 60 * 60 * 1000);
      }
    }
  } finally {
    library.close();
  }
}

async function writeSmokeSettings() {
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify(
      {
        libraryRoots: [mediaDir],
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
        openaiModel: 'gpt-5.4-mini',
        firstLaunchTutorialSeen: true,
        crossfadeMs: 0,
        replayGain: 'off',
        limiterEnabled: true,
        preampDb: 0,
        resumeState: null,
        compactMode: false,
        alwaysOnTop: false,
        visualizerPreset: 'spectrum',
        volume: 0,
        playbackRate: 1,
        audioOutputDeviceId: null,
        autoDjEnabled: false,
        autoDjTarget: 24,
        autoDjSmartRuleId: null,
        equalizer: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        eqEnabled: false,
      },
      null,
      2,
    ),
    'utf8',
  );
}

function runElectronSmoke() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(String(electronPath), ['.'], {
      cwd: appRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEWAMP_UI_DISCOVER_SMOKE: '1',
        NEWAMP_SMOKE_USER_DATA: userData,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      finish(new Error(`UI Discover smoke timed out without result marker. stderr:\n${tail(stderr)}`));
    }, 45000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith(marker)) continue;
        try {
          const parsed = JSON.parse(line.slice(marker.length));
          finish(null, parsed);
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => finish(err));
    child.on('exit', (code) => {
      if (!settled && code !== 0) {
        finish(new Error(`Electron exited ${code ?? 'without code'} before UI Discover result.\nstderr:\n${tail(stderr)}`));
      }
    });

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!child.killed) child.kill();
      if (err) rejectPromise(err);
      else resolvePromise(value);
    }
  });
}

function tail(text) {
  return text.split(/\r?\n/).slice(-60).join('\n');
}
