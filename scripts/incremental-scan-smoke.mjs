import assert from 'node:assert/strict';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const smokeRoot = join(repoRoot, 'tmp', 'incremental-scan-smoke');
const musicRoot = join(smokeRoot, 'music');
const dbPath = join(smokeRoot, 'library.db');

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });

const firstTrack = join(musicRoot, '01-unchanged.mp3');
const secondTrack = join(musicRoot, '02-touched.mp3');
await writeFile(firstTrack, Buffer.from('first fixture'));
await writeFile(secondTrack, Buffer.from('second fixture'));

const library = await LibraryStore.open(dbPath);
try {
  const firstProgress = [];
  await new Scanner(library, (event) => firstProgress.push(event)).start([musicRoot]);
  assert.equal(library.getStats().tracks, 2, 'first scan should catalog fixtures');
  const firstDone = firstProgress.findLast((event) => event.done);
  assert.equal(firstDone?.parsed, 2, 'first scan should parse new tracks');
  assert.equal(firstDone?.skipped, 0, 'first scan should not skip new tracks');
  const alternatePath = firstTrack.replace(/\\/g, '/').toUpperCase();
  assert.equal(
    library.getTrackFileStates([alternatePath]).get(alternatePath)?.size,
    Buffer.byteLength('first fixture'),
    'file-state lookup should tolerate Windows path slash/case variation',
  );

  const secondProgress = [];
  await new Scanner(library, (event) => secondProgress.push(event)).start([musicRoot]);
  const secondDone = secondProgress.findLast((event) => event.done);
  assert.equal(secondDone?.parsed, 0, 'unchanged rescan should parse no tracks');
  assert.equal(secondDone?.skipped, 2, 'unchanged rescan should skip both existing tracks');
  assert.equal(library.getStats().tracks, 2, 'unchanged rescan should preserve catalog rows');

  await writeFile(secondTrack, Buffer.from('second fixture touched'));
  const touchedAt = new Date(Date.now() + 2000);
  await utimes(secondTrack, touchedAt, touchedAt);

  const thirdProgress = [];
  await new Scanner(library, (event) => thirdProgress.push(event)).start([musicRoot]);
  const thirdDone = thirdProgress.findLast((event) => event.done);
  assert.equal(thirdDone?.parsed, 1, 'changed rescan should parse only the touched track');
  assert.equal(thirdDone?.skipped, 1, 'changed rescan should skip the unchanged track');

  const [typesSource, scannerSource, librarySource, scanBannerSource, packageSource] = await Promise.all([
    readText('../shared/types.ts'),
    readText('../electron/scanner.ts'),
    readText('../electron/library.ts'),
    readText('../src/components/ScanBanner.tsx'),
    readText('../package.json'),
  ]);

  assert.match(typesSource, /skipped\?: number/, 'ScanProgress should expose skipped tracks');
  assert.match(typesSource, /parsed\?: number/, 'ScanProgress should expose parsed tracks');
  assert.match(scannerSource, /getTrackFileStates/, 'scanner should compare discovered files to catalog file state');
  assert.match(librarySource, /getTrackFileStates/, 'library should expose catalog file state for scanner');
  assert.match(scanBannerSource, /skipped/, 'scan banner should surface skipped-file counts for large rescans');
  assert.match(packageSource, /smoke:incremental-scan/, 'package scripts should expose incremental scan smoke');

  console.log(JSON.stringify({
    ok: true,
    first: firstDone,
    second: secondDone,
    third: thirdDone,
  }, null, 2));
} finally {
  library.close();
}

async function readText(relativePath) {
  return import('node:fs/promises').then((fs) => fs.readFile(new URL(relativePath, import.meta.url), 'utf8'));
}
