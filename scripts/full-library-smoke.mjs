import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';
import { playbackMode } from '../dist-electron/electron/transcode.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'full-library-smoke');
const dbPath = join(smokeRoot, 'library.db');
const root = resolve(process.argv[2] ?? 'K:/music');
const minTracks = Number.parseInt(process.env.NEWAMP_FULL_SCAN_MIN_TRACKS ?? '5000', 10);
const maxMs = Number.parseInt(process.env.NEWAMP_FULL_SCAN_MAX_MS ?? '300000', 10);
const clean = process.env.NEWAMP_FULL_SCAN_CLEAN === '1';

if (!existsSync(root)) {
  console.error(`library root does not exist: ${root}`);
  process.exit(2);
}

if (clean) {
  const resolvedSmokeRoot = resolve(smokeRoot);
  if (!resolvedSmokeRoot.startsWith(repoRoot + '\\')) {
    throw new Error(`refusing to clean outside repo: ${resolvedSmokeRoot}`);
  }
  await rm(resolvedSmokeRoot, { recursive: true, force: true });
}

await mkdir(smokeRoot, { recursive: true });

const startedAt = Date.now();
const progress = [];
let lastLogAt = 0;

const library = await LibraryStore.open(dbPath);
const scanner = new Scanner(library, (event) => {
  progress.push(event);
  const now = Date.now();
  if (!event.done && now - lastLogAt < 2500) return;
  lastLogAt = now;
  const elapsed = ((now - startedAt) / 1000).toFixed(1);
  const phase = event.scanned === 0 && !event.done ? 'discovering' : 'scanning';
  const count = event.scanned === 0 ? event.total : `${event.scanned}/${event.total}`;
  console.error(`[newamp] ${phase} ${count} elapsed=${elapsed}s current=${event.current}`);
});

try {
  await scanner.start([root]);

  const elapsedMs = Date.now() - startedAt;
  const stats = library.getStats();
  const tracks = library.getTracks({ sort: 'artist', limit: 100000 });
  const extensionCounts = countExtensions(tracks.map((track) => track.path));
  const playbackCounts = countValues(tracks.map((track) => playbackMode(track.path)));
  const fallbackSample = tracks.find((track) => playbackMode(track.path) === 'ffmpeg') ?? null;
  const nativeSample = tracks.find((track) => playbackMode(track.path) === 'native') ?? null;
  const doneEvent = progress.findLast((event) => event.done);

  const checks = {
    rootExists: true,
    progressDone: !!doneEvent,
    trackCountAtLeastMinimum: stats.tracks >= minTracks,
    albumsPresent: stats.albums > 0,
    artistsPresent: stats.artists > 0,
    durationPresent: stats.duration > 0,
    underTimeBudget: elapsedMs <= maxMs,
    nativePlaybackCandidate: !!nativeSample,
  };

  const ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({
    ok,
    root,
    dbPath,
    elapsedMs,
    thresholds: {
      minTracks,
      maxMs,
    },
    checks,
    stats,
    progressEvents: progress.length,
    extensions: extensionCounts,
    playbackModes: playbackCounts,
    nativeSample: nativeSample ? pickTrack(nativeSample) : null,
    fallbackSample: fallbackSample ? pickTrack(fallbackSample) : null,
    finalProgress: doneEvent ?? null,
  }, null, 2));

  process.exitCode = ok ? 0 : 1;
} finally {
  library.close();
}

function countExtensions(paths) {
  return countValues(paths.map((path) => {
    const match = path.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : 'unknown';
  }));
}

function countValues(values) {
  return Object.fromEntries([...values.reduce((map, value) => {
    map.set(value, (map.get(value) ?? 0) + 1);
    return map;
  }, new Map()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function pickTrack(track) {
  return {
    id: track.id,
    path: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
  };
}
