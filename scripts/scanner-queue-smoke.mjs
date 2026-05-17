import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'scanner-queue-smoke');
const firstRoot = join(smokeRoot, 'first');
const secondRoot = join(smokeRoot, 'second');
const thirdRoot = join(smokeRoot, 'third');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(firstRoot, { recursive: true });
await mkdir(secondRoot, { recursive: true });
await mkdir(thirdRoot, { recursive: true });
await writeFile(join(firstRoot, '01-first.mp3'), Buffer.from('first queue fixture'));
await writeFile(join(secondRoot, '02-second.mp3'), Buffer.from('second queue fixture'));
await writeFile(join(thirdRoot, '03-third.mp3'), Buffer.from('third queue fixture'));

const library = await LibraryStore.open(dbPath);
try {
  const progress = [];
  const scanner = new Scanner(library, (event) => progress.push(event));
  const firstRun = scanner.start([firstRoot, thirdRoot]);
  const secondRun = scanner.start([secondRoot]);
  await Promise.all([firstRun, secondRun]);

  const tracks = library.getTracks({ sort: 'artist', limit: 10 });
  assert.equal(tracks.length, 3, 'overlapping scanner starts should catalog every root they are given');
  assert.ok(
    tracks.some((track) => track.path.endsWith('01-first.mp3')),
    'first queued scan target should be cataloged',
  );
  assert.ok(
    tracks.some((track) => track.path.endsWith('03-third.mp3')),
    'multi-root scanner discovery should catalog sibling roots from one scan request',
  );
  assert.ok(
    tracks.some((track) => track.path.endsWith('02-second.mp3')),
    'second queued scan target should be cataloged after the active scan finishes',
  );
  assert.equal(
    progress.filter((event) => event.done).length,
    2,
    'each queued scan should publish its own completion event',
  );

  const [scannerSource, mainSource, packageSource] = await Promise.all([
    readText('../electron/scanner.ts'),
    readText('../electron/main.ts'),
    readText('../package.json'),
  ]);
  assert.match(scannerSource, /scanQueue/, 'scanner should serialize start requests through a queue');
  assert.match(scannerSource, /DISCOVERY_CONCURRENCY/, 'scanner should discover multiple configured roots concurrently');
  assert.match(scannerSource, /METADATA_BATCH_SIZE\s*=\s*128/, 'scanner should batch metadata writes for large libraries');
  assert.match(scannerSource, /folderArtBlobCache/, 'scanner should reuse folder cover bytes across album tracks');
  assert.match(mainSource, /return scanner\.start\(targets\)/, 'library scan IPC should resolve after the queued scan finishes');
  assert.match(packageSource, /smoke:scanner-queue/, 'package scripts should expose scanner queue smoke');

  console.log(JSON.stringify({ ok: true, tracks: tracks.map((track) => track.path) }, null, 2));
} finally {
  library.close();
}

async function readText(relativePath) {
  return import('node:fs/promises').then((fs) => fs.readFile(new URL(relativePath, import.meta.url), 'utf8'));
}
