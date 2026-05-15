import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';
import { playbackMode } from '../dist-electron/electron/transcode.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'library-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

const fixtures = [
  { name: '01-neon-pulse.mp3', title: 'Neon Pulse', freq: 330, codec: ['-c:a', 'libmp3lame', '-q:a', '6'] },
  { name: '02-glass-memory.flac', title: 'Glass Memory', freq: 392, codec: ['-c:a', 'flac'] },
  { name: '03-windowshade.ogg', title: 'Windowshade', freq: 494, codec: ['-c:a', 'libvorbis', '-q:a', '4'] },
  { name: '04-asf-fallback.wma', title: 'ASF Fallback', freq: 587, codec: ['-c:a', 'wmav2'] },
  { name: '05-big-endian.aiff', title: 'Big Endian', freq: 659, codec: ['-c:a', 'pcm_s16be'] },
  { name: '06-local-wave.wav', title: 'Local Wave', freq: 740, codec: ['-c:a', 'pcm_s16le'] },
  {
    name: 'disc-1/07-parent-folder-cover.mp3',
    title: 'Parent Folder Cover',
    album: 'Multi Disc Smoke',
    freq: 880,
    codec: ['-c:a', 'libmp3lame', '-q:a', '6'],
  },
];

if (!ffmpeg) {
  console.error('ffmpeg-static did not resolve a binary for this platform');
  process.exit(1);
}

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });
const multiDiscRoot = join(musicRoot, 'multi-disc');
await mkdir(join(multiDiscRoot, 'disc-1'), { recursive: true });
await writeFile(join(musicRoot, 'cover.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
));
await writeFile(join(multiDiscRoot, 'cover.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M/wHwAEBgIAgDZF4gAAAABJRU5ErkJggg==',
  'base64',
));

for (const fixture of fixtures) {
  const target = fixture.name.startsWith('disc-1/')
    ? join(multiDiscRoot, fixture.name)
    : join(musicRoot, fixture.name);
  runFfmpeg([
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${fixture.freq}:duration=0.7`,
    '-metadata',
    `title=${fixture.title}`,
    '-metadata',
    'artist=Newamp Fixture Artist',
    '-metadata',
    `album=${fixture.album ?? 'Smoke Signals'}`,
    '-metadata',
    'album_artist=Newamp Fixture Artist',
    '-metadata',
    'genre=Fixture',
    '-metadata',
    'date=2026',
    ...fixture.codec,
    target,
  ]);
  if (!existsSync(target)) throw new Error(`fixture was not created: ${target}`);
}

const progress = [];
const library = await LibraryStore.open(dbPath);
const scanner = new Scanner(library, (p) => progress.push(p));
await scanner.start([musicRoot]);

const stats = library.getStats();
const tracks = library.getTracks({ sort: 'album', limit: 100 });
const artTrack = tracks.find((track) => track.hasArt);
const parentCoverTrack = tracks.find((track) => track.title === 'Parent Folder Cover');
const parentCoverArt = parentCoverTrack ? library.getArt(parentCoverTrack.id) : null;
const art = artTrack ? library.getArt(artTrack.id) : null;
const extensions = tracks.map((track) => track.path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()).sort();
const fallbackModes = Object.fromEntries(
  tracks.map((track) => [
    track.path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? 'unknown',
    playbackMode(track.path),
  ]),
);

library.close();

const expectedExts = fixtures.map((fixture) => fixture.name.split('.').pop()).sort();
const checks = {
  trackCount: stats.tracks === fixtures.length,
  albumCount: stats.albums === 2,
  fixtureArtistPresent: tracks.some((track) => track.artist === 'Newamp Fixture Artist'),
  noBlankArtists: tracks.every((track) => track.artist.trim().length > 0),
  duration: stats.duration > 3,
  extensions: JSON.stringify(extensions) === JSON.stringify(expectedExts),
  albumArt: !!art && art.mime === 'image/png' && art.data.length > 0,
  parentFolderAlbumArt: !!parentCoverTrack?.hasArt && !!parentCoverArt && parentCoverArt.data.length > 0,
  progressDone: progress.some((p) => p.done && p.scanned === fixtures.length && p.total === fixtures.length),
  wmaFallback: fallbackModes.wma === 'ffmpeg',
  aiffFallback: fallbackModes.aiff === 'ffmpeg',
};

const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({
  ok,
  checks,
  stats,
  extensions,
  fallbackModes,
  progressEvents: progress.length,
  sampleTrack: tracks[0] ?? null,
}, null, 2));

process.exit(ok ? 0 : 1);

function runFfmpeg(args) {
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${result.status})\n${result.stderr || result.stdout}`);
  }
}
