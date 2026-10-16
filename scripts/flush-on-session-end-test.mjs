// The stores batch their writes (800 ms for edits and the resume position, up
// to 30 s for plays and skips), and the quit path lands them. A Windows
// log-off or restart, a Linux/macOS shutdown and an uncaught exception end the
// process without going through that path, so up to half a minute of plays and
// the last resume position were lost each time. Each of those now flushes
// every store first, and one store failing does not stop the others.
//
// Run: npm run build:electron && node scripts/flush-on-session-end-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { transform } from 'esbuild';
import initSqlJs from 'sql.js';
import { LibraryStore } from '../dist-electron/electron/library.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const main = readFileSync(join(repoRoot, 'electron/main.ts'), 'utf8').replace(/\r\n/g, '\n');

// ---- the real library: flushNow lands the batched play and leaves the store open ----
{
  const root = join(repoRoot, 'tmp', 'flush-on-session-end-test');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const dbPath = join(root, 'library.db');
  const SQL = await initSqlJs();
  const playCountOnDisk = () => {
    const db = new SQL.Database(readFileSync(dbPath));
    try {
      return db.exec('SELECT play_count FROM tracks')[0]?.values[0]?.[0] ?? null;
    } finally {
      db.close();
    }
  };

  const library = await LibraryStore.open(dbPath);
  try {
    library.upsertTracks([{
      path: join(root, 'a.mp3'), title: 'A', artist: 'X', album: 'Y', albumArtist: 'X', trackNo: 1, discNo: null,
      year: null, genre: null, duration: 60, bitrate: null, sampleRate: null, replayGainTrackDb: null,
      replayGainAlbumDb: null, size: 10, mtime: 1, art: null,
    }]);
    library.flushNow();
    assert.equal(playCountOnDisk(), 0, 'the track is on disk with no plays yet');

    const [track] = library.getTracks({ limit: 1 });
    library.recordPlay(track.id);
    assert.equal(playCountOnDisk(), 0, 'a play waits in memory for its 30 s timer');
    library.flushNow();
    assert.equal(playCountOnDisk(), 1, 'flushNow writes it without waiting');

    // The store is still usable afterwards, which a session-end that does not end the app needs.
    library.recordPlay(track.id);
    library.flushNow();
    assert.equal(playCountOnDisk(), 2, 'it keeps working after a flush');
    library.flushNow();
    assert.equal(playCountOnDisk(), 2, 'flushing with nothing batched is harmless');
  } finally {
    library.close();
  }
  await rm(root, { recursive: true, force: true });
}

// ---- main.ts: the flush itself, run as written ----
const startAt = main.indexOf('let flushingStores = false;');
const endMarker = "process.on('uncaughtException'";
const handlerStart = main.indexOf(endMarker);
const handlerEnd = main.indexOf('\n});\n', handlerStart) + 5;
assert.ok(startAt !== -1 && handlerStart > startAt && handlerEnd > handlerStart, 'main.ts has flushAllStores and the uncaughtException handler');
const code = (await transform(main.slice(startAt, handlerEnd), { loader: 'ts' })).code;

function fixture({ failing = [] } = {}) {
  const calls = [];
  const store = (name, method) => ({
    [method]() {
      calls.push(name);
      if (failing.includes(name)) throw new Error(`${name} is locked`);
    },
  });
  const handlers = new Map();
  const context = {
    library: store('library', 'flushNow'),
    settings: store('settings', 'flushSync'),
    podcastStore: store('podcasts', 'flushProgressSync'),
    console: { error() {}, warn() {} },
    writeDiagnosticEvent: (kind) => calls.push(`event:${kind}`),
    process: {
      on: (event, handler) => handlers.set(event, handler),
      exit: (code) => calls.push(`exit:${code}`),
    },
  };
  vm.runInNewContext(`${code}\nthis.flushAllStores = flushAllStores;`, context);
  return { calls, handlers, context };
}

{
  const f = fixture();
  f.context.flushAllStores();
  assert.deepEqual(f.calls, ['library', 'settings', 'podcasts'], 'every store is flushed');
}

{
  const f = fixture({ failing: ['library'] });
  f.context.flushAllStores();
  assert.deepEqual(f.calls, ['library', 'settings', 'podcasts'], 'a library that cannot flush does not stop the others');
  f.calls.length = 0;
  f.context.flushAllStores();
  assert.equal(f.calls.length, 3, 'a failure does not wedge the next flush');
}

{
  // A flush that itself ends in an exception must not come back into itself.
  const f = fixture();
  let depth = 0;
  f.context.library.flushNow = () => {
    depth += 1;
    f.calls.push('library');
    if (depth === 1) f.context.flushAllStores();
  };
  f.context.flushAllStores();
  assert.equal(f.calls.filter((call) => call === 'library').length, 1, 're-entering is ignored');
}

{
  // The crash path: record it, land the data, and only then exit.
  const f = fixture();
  const handler = f.handlers.get('uncaughtException');
  assert.ok(handler, 'there is an uncaughtException handler');
  handler(new Error('boom'), 'uncaughtException');
  assert.deepEqual(
    f.calls,
    ['event:main-uncaught-exception', 'library', 'settings', 'podcasts', 'exit:1'],
    'the stores are flushed before the process exits',
  );
}

// ---- main.ts: who calls it ----
{
  const created = main.match(/app\.on\('browser-window-created', \(_event, created\) => \{[\s\S]*?\n\}\);\n/)?.[0] ?? '';
  assert.match(created, /created\.on\('session-end', flushAllStores\);/, 'Windows log-off and restart');
  const bootstrap = main.slice(main.indexOf('async function bootstrap(): Promise<void> {'));
  assert.match(bootstrap, /powerMonitor\.on\('shutdown', flushAllStores\);/, 'Linux and macOS shutdown');

  // will-quit: a failing library close no longer skips the settings and podcast writes.
  const willQuit = main.match(/app\.on\('will-quit', \(event\) => \{[\s\S]*?\n\}\);\n/)?.[0] ?? '';
  assert.match(willQuit, /try \{\s*library\?\.close\(\);\s*\} catch \(err\) \{/);
  assert.ok(willQuit.indexOf('library?.close()') < willQuit.indexOf('settings?.flushSync()'));
}

console.log('PASS flush on session end: log-off, shutdown and crash land every store first; one failing store does not stop the rest');
