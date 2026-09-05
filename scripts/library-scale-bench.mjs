import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const trackCount = boundedPositiveInt(args.tracks ?? process.env.NEWAMP_SCALE_TRACKS, 350000, 'tracks', 500000);
const batchSize = boundedPositiveInt(args.batchSize ?? process.env.NEWAMP_SCALE_BATCH_SIZE, 5000, 'batchSize', 50000);
const pageSize = boundedPositiveInt(args.pageSize ?? process.env.NEWAMP_SCALE_PAGE_SIZE, 600, 'pageSize', 5000);
const cleanAfter = args.cleanAfter === true || process.env.NEWAMP_SCALE_CLEAN_AFTER === '1';
const benchParent = join(repoRoot, 'tmp', 'library-scale-bench');
if (!existsSync(join(repoRoot, 'dist-electron', 'electron', 'library.js'))) {
  console.error('dist-electron/electron/library.js is missing; run npm run build:electron first.');
  process.exit(2);
}

const { LibraryStore } = await import('../dist-electron/electron/library.js');
const benchRoot = await createBenchmarkRoot(benchParent);
const dbPath = join(benchRoot, 'library.db');

const report = {
  ok: false,
  dataset: {
    kind: 'synthetic',
    trackCount,
    batchSize,
    pageSize,
    note: 'Rows are generated metadata records only; this does not parse real audio files or prove filesystem scan speed.',
  },
  paths: {
    dbPath,
    reportPath: join(benchRoot, 'report.json'),
  },
  timings_ms: {},
  blocked_event_loop_ms: {},
  row_counts: {},
  memory_mb: {},
  db_bytes: null,
};

let peakRssMb = memoryMb().rss;
const markMemory = (label) => {
  const current = memoryMb();
  peakRssMb = Math.max(peakRssMb, current.rss);
  report.memory_mb[label] = current;
};

markMemory('start');
let library = null;

try {
  library = await LibraryStore.open(dbPath);
  const importResult = await measure('importSyntheticTracks', async () => {
    for (let offset = 0; offset < trackCount; offset += batchSize) {
      const count = Math.min(batchSize, trackCount - offset);
      library.upsertTracks(makeTracks(offset, count, benchRoot));
      if (offset && offset % (batchSize * 10) === 0) markMemory(`after_${offset}_rows`);
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  recordMeasure(report, importResult);
  markMemory('after_import');

  await runQueryBenchmarks(library, report, trackCount, pageSize);
  markMemory('after_queries');

  const drainResult = await measure('waitForPendingWrites', () => library.waitForPendingWrites());
  recordMeasure(report, drainResult);

  const closeResult = await measure('closeFlush', () => library.close());
  recordMeasure(report, closeResult);
  library = null;
  markMemory('after_close');

  const reopenResult = await measure('reopenExistingLibrary', async () => {
    library = await LibraryStore.open(dbPath);
  });
  recordMeasure(report, reopenResult);
  markMemory('after_reopen');

  await runQueryBenchmarks(library, report, trackCount, pageSize, 'reopened_');
  report.db_bytes = (await stat(dbPath)).size;
  report.memory_mb.peakRss = round(peakRssMb);

  const expectedStats = report.row_counts.stats?.tracks ?? report.row_counts.reopened_stats?.tracks;
  report.ok =
    expectedStats === trackCount &&
    report.row_counts.firstPage === Math.min(pageSize, trackCount) &&
    report.row_counts.deepPage > 0 &&
    report.row_counts.titleSearch > 0 &&
    report.row_counts.reopened_firstPage === Math.min(pageSize, trackCount);
  await writeFile(report.paths.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
} finally {
  try {
    library?.close();
  } finally {
    if (cleanAfter) await rm(benchRoot, { recursive: true, force: true });
  }
}

async function runQueryBenchmarks(library, report, total, pageSize, prefix = '') {
  const deepOffset = Math.max(0, total - pageSize);
  await query(`${prefix}stats`, report, () => library.getStats(), (stats) => {
    report.row_counts[`${prefix}stats`] = stats;
  });
  await query(`${prefix}countAll`, report, () => library.getTrackCount(), (count) => {
    report.row_counts[`${prefix}countAll`] = count;
  });
  await query(`${prefix}firstPageArtistSort`, report, () => library.getTracks({ sort: 'artist', limit: pageSize, offset: 0 }), (rows) => {
    report.row_counts[`${prefix}firstPage`] = rows.length;
  });
  await query(`${prefix}deepPageArtistSort`, report, () => library.getTracks({ sort: 'artist', limit: pageSize, offset: deepOffset }), (rows) => {
    report.row_counts[`${prefix}deepPage`] = rows.length;
  });
  await query(`${prefix}titleSearch`, report, () => library.getTracks({ search: 'needle', sort: 'title', limit: pageSize, offset: 0 }), (rows) => {
    report.row_counts[`${prefix}titleSearch`] = rows.length;
  });
  await query(`${prefix}artistSearchCount`, report, () => library.getTrackCount({ search: 'Bench Artist 0042', sort: 'artist' }), (count) => {
    report.row_counts[`${prefix}artistSearchCount`] = count;
  });
  await query(`${prefix}albumPage`, report, () => library.getAlbums({ sort: 'artist', limit: 320, offset: 0 }), (rows) => {
    report.row_counts[`${prefix}albumPage`] = rows.length;
  });
  await query(`${prefix}albumSearch`, report, () => library.getAlbums({ search: 'Scale Album 00042', sort: 'artist', limit: 320, offset: 0 }), (rows) => {
    report.row_counts[`${prefix}albumSearch`] = rows.length;
  });
  await query(`${prefix}artistPage`, report, () => library.getArtists({ sort: 'artist', limit: 400, offset: 0 }), (rows) => {
    report.row_counts[`${prefix}artistPage`] = rows.length;
  });
  await query(`${prefix}trackIds100k`, report, () => library.getTrackIds({ sort: 'artist', limit: 100000, offset: 0 }), (rows) => {
    report.row_counts[`${prefix}trackIds100k`] = rows.length;
  });
}

async function query(label, report, fn, capture) {
  const result = await measure(label, fn);
  recordMeasure(report, result);
  capture(result.value);
}

function recordMeasure(report, result) {
  report.timings_ms[result.label] = result.ms;
  report.blocked_event_loop_ms[result.label] = result.blockedMs;
}

async function measure(label, fn) {
  const intervalMs = 10;
  let maxDelay = 0;
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    maxDelay = Math.max(maxDelay, now - expected);
    expected = now + intervalMs;
  }, intervalMs);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const started = performance.now();
    const value = await fn();
    const ms = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { label, value, ms: round(ms), blockedMs: round(Math.max(0, maxDelay)) };
  } finally {
    clearInterval(timer);
  }
}

function makeTracks(offset, count, root) {
  return Array.from({ length: count }, (_, i) => {
    const n = offset + i;
    const albumNo = Math.floor(n / 20);
    const artistNo = Math.floor(n / 70);
    return {
      path: join(root, 'synthetic-music', `artist-${pad(artistNo, 5)}`, `album-${pad(albumNo, 5)}`, `track-${pad(n, 6)}.flac`),
      title: `${n % 1000 === 0 ? 'Needle ' : ''}Synthetic Track ${pad(n, 6)}`,
      artist: `Bench Artist ${pad(artistNo, 5)}`,
      album: `Scale Album ${pad(albumNo, 5)}`,
      albumArtist: `Bench Artist ${pad(artistNo, 5)}`,
      trackNo: (n % 20) + 1,
      discNo: null,
      year: 1970 + (n % 55),
      genre: n % 3 === 0 ? 'Rock' : n % 3 === 1 ? 'Electronic' : 'Jazz',
      duration: 120 + (n % 360),
      bitrate: 800000 + (n % 8) * 64000,
      sampleRate: n % 5 === 0 ? 96000 : 44100,
      bpm: 70 + (n % 110),
      key: null,
      replayGainTrackDb: null,
      replayGainAlbumDb: null,
      size: 3_000_000 + n,
      mtime: 1_700_000_000_000 + n,
      art: null,
    };
  });
}

function parseArgs(argv) {
  const out = {};
  const allowed = new Set(['tracks', 'batchSize', 'pageSize']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--clean-after') {
      out.cleanAfter = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (!allowed.has(key)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function boundedPositiveInt(value, fallback, label, max) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`${label} must be a positive integer.`);
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${label} must be between 1 and ${max}.`);
  }
  return parsed;
}

function memoryMb() {
  const usage = process.memoryUsage();
  return {
    rss: round(usage.rss / 1024 / 1024),
    heapUsed: round(usage.heapUsed / 1024 / 1024),
    external: round(usage.external / 1024 / 1024),
    arrayBuffers: round(usage.arrayBuffers / 1024 / 1024),
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

async function createBenchmarkRoot(parent) {
  await ensurePlainDirectoryChain(parent);
  return mkdtemp(join(parent, 'run-'));
}

async function ensurePlainDirectoryChain(target) {
  const rel = relative(repoRoot, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Benchmark directory must stay under the repository tmp directory: ${target}`);
  }
  await assertPlainDirectory(repoRoot);
  let current = repoRoot;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) {
      await mkdir(current);
    }
    await assertPlainDirectory(current);
  }
}

async function assertPlainDirectory(path) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Benchmark directory ancestor must be a real directory: ${path}`);
  }
}
