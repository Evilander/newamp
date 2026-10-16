// A scan that is cancelled still ends with a done event, marked cancelled.
// Without one the scan banner stayed on "Scanning" after Cancel, and nothing
// that waits for a finished scan (the list refresh, the title bar's track
// count) ever heard that it was over.
// Run: npm run build:electron && node scripts/scan-cancel-done-test.mjs
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner } from '../dist-electron/electron/scanner.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'scan-cancel-done-test');
const musicRoot = join(root, 'music');
await rm(root, { recursive: true, force: true });
await mkdir(musicRoot, { recursive: true });
// More files than one discovery report (200) and one metadata batch (128), so
// a cancel has both a walk and a batch boundary to land on.
for (let i = 0; i < 450; i += 1) {
  await writeFile(join(musicRoot, `${String(i).padStart(4, '0')}-track.mp3`), Buffer.from(`fixture ${i}`));
}

async function scan(name, shouldCancel) {
  const library = await LibraryStore.open(join(root, `${name}.db`));
  try {
    const events = [];
    let scanner;
    scanner = new Scanner(library, (event) => {
      events.push(event);
      if (!event.done && shouldCancel(event)) scanner.cancel();
    });
    await scanner.start([musicRoot]);
    return events;
  } finally {
    library.close();
  }
}

// ---- cancelled while the folders are still being walked ----
{
  const events = await scan('walk', (event) => event.scanned === 0);
  const ends = events.filter((event) => event.done);
  assert.equal(ends.length, 1, 'exactly one end event');
  assert.equal(events.at(-1), ends[0], 'and it is the last thing reported');
  assert.equal(ends[0].cancelled, true, 'marked cancelled');
  assert.equal(ends[0].scanned, 0);
  assert.equal(ends[0].total, 0, 'it claims nothing was indexed');
}

// ---- cancelled between metadata batches ----
{
  const events = await scan('batch', (event) => event.scanned > 0);
  const ends = events.filter((event) => event.done);
  assert.equal(ends.length, 1);
  assert.equal(events.at(-1), ends[0]);
  assert.equal(ends[0].cancelled, true);
  assert.ok(ends[0].scanned > 0 && ends[0].scanned < 450, `it stopped part-way: ${ends[0].scanned} of 450`);
  assert.equal(ends[0].total, ends[0].scanned, 'the end event counts what was indexed, not what was found');
}

// ---- a scan nobody cancels ends the usual way ----
{
  const events = await scan('whole', () => false);
  const ends = events.filter((event) => event.done);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].cancelled, undefined, 'a finished scan is not marked cancelled');
  assert.equal(ends[0].total, 450);
  assert.equal(ends[0].scanned, 450);
}

// ---- the main process hands the final event to the window ----
{
  const [types, main] = await Promise.all([
    readFile(new URL('../shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(types.replace(/\r\n/g, '\n'), /interface ScanProgress \{[\s\S]*?cancelled\?: boolean;/, 'the type carries the flag');
  assert.match(
    main.replace(/\r\n/g, '\n'),
    /if \(!mainWin \|\| mainWin\.isDestroyed\(\)\) return;\n\s*mainWin\.webContents\.send\('library:scan-progress', p\);/,
    'the quit-time cancel does not send to a window that is gone',
  );
}

await rm(root, { recursive: true, force: true });

// The banner says the scan stopped, not that it completed.
const banner = (await readFile(join(repoRoot, 'src/components/ScanBanner.tsx'), 'utf8')).replace(/\r\n/g, '\n');
assert.match(banner, /progress\.cancelled \? '● Scan stopped' : '● Scan complete'/, 'a cancelled scan is not called complete');

console.log('PASS scan cancel: a cancelled scan reports a final done event marked cancelled, from the walk and from a batch');
