// How electron/main.ts treats a slow or failing network share, opened files,
// the Dock and File menus, and the quit path. main.ts cannot be loaded outside
// Electron, so each piece is cut out of the source as written, compiled, and run
// against stubs.
// Run: node scripts/main-storage-wiring-test.mjs
import assert from 'node:assert/strict';
import { build, transform } from 'esbuild';
import { statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const main = (await readFile(resolve(root, 'electron/main.ts'), 'utf8')).replace(/\r\n/g, '\n');

// The text of one top-level declaration: a function (to its closing brace at
// column 0), or a const/let/type statement (to its terminating semicolon line).
function grab(signature) {
  const start = main.indexOf(signature);
  assert.ok(start !== -1, `main.ts has ${signature}`);
  const isFunction = /^(async )?function /.test(signature);
  const end = main.indexOf(isFunction ? '\n}\n' : ';\n', start);
  assert.ok(end !== -1, `${signature} ends`);
  return main.slice(start, end + (isFunction ? 2 : 1));
}

async function load(pieces, context) {
  const { code } = await transform(pieces.join('\n'), { loader: 'ts', target: 'es2022' });
  vm.runInNewContext(`${code}\nthis.__exports = { ${exportsOf(pieces).join(', ')} };`, context);
  return context.__exports;
}

function exportsOf(pieces) {
  return pieces
    .map((piece) => /^(?:async )?function (\w+)\(/.exec(piece)?.[1] ?? /^(?:const|let) (\w+)/.exec(piece)?.[1])
    .filter(Boolean);
}

const errno = (code) => Object.assign(new Error(code), { code });
const isStorageError = (err) => ['ETIMEDOUT', 'EIO', 'EAGAIN', 'ESTALE'].includes(err?.code);
const instantly = (fn) => { fn(); return 0; };
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---- opened files accept every extension a scan indexes ----------------------
{
  assert.match(main, /import \{ AUDIO_EXTS, [^}]*\} from '\.\/library-skip\.js';/, 'main.ts reads the scan list from library-skip.ts');
  assert.match(main, /const OPEN_AUDIO_EXTS = AUDIO_EXTS;/, 'and opens the same extensions, with no list of its own to drift');
  const skip = await readFile(resolve(root, 'electron/library-skip.ts'), 'utf8');
  const body = /AUDIO_EXTS(?::[^=]+)? = new Set\(\[([\s\S]*?)\]\)/.exec(skip)?.[1] ?? '';
  const indexed = [...body.matchAll(/'(\.[a-z0-9]+)'/g)].map((m) => m[1]);
  for (const ext of ['.m4b', '.mp4', '.alac', '.mp3', '.flac']) assert.ok(indexed.includes(ext), `${ext} opens`);
  const scanner = await readFile(resolve(root, 'electron/scanner.ts'), 'utf8');
  assert.match(scanner, /import \{ AUDIO_EXTS[^}]*\} from '\.\/library-skip\.js'/, 'the scanner indexes the same list');
}

// ---- playback mode stays what it was, and a dead share fails the request ----
{
  const pieces = [
    grab('const servedModes'),
    grab('const SERVED_MODE_IDLE_MS'),
    grab('const SERVED_MODE_CAP'),
    grab('const PLAYBACK_MODE_RETRY_DELAYS_MS'),
    grab('async function servedPlaybackMode('),
  ];
  const probes = [];
  const context = { Date, Map, isStorageError, setTimeout: instantly, resolvePlaybackMode: async () => probes.shift()() };
  const { servedPlaybackMode } = await load(pieces, context);

  probes.push(() => 'ffmpeg');
  assert.equal(await servedPlaybackMode('/m/alac.m4a'), 'ffmpeg');
  probes.push(() => 'native');
  assert.equal(await servedPlaybackMode('/m/alac.m4a'), 'ffmpeg', 'a seek is answered the way the stream began, without probing again');
  assert.equal(probes.length, 1, 'the probe was not asked');
  probes.length = 0;

  probes.push(() => { throw errno('ETIMEDOUT'); }, () => { throw errno('EIO'); }, () => 'native');
  assert.equal(await servedPlaybackMode('/m/aac.m4a'), 'native', 'a probe that times out twice is retried');

  probes.push(() => { throw errno('ETIMEDOUT'); }, () => { throw errno('ETIMEDOUT'); }, () => { throw errno('ETIMEDOUT'); });
  await assert.rejects(servedPlaybackMode('/m/down.m4a'), { code: 'ETIMEDOUT' }, 'a share that stays away fails the request (the handler answers 503)');
  probes.push(() => { throw errno('ENOENT'); });
  await assert.rejects(servedPlaybackMode('/m/gone.m4a'), { code: 'ENOENT' }, 'another error is not retried');
}

// ---- the protocol handler maps the outcomes -----------------------------------
{
  const handler = grab('function storageUnavailableResponse(');
  assert.match(handler, /status: 503/);
  assert.match(main, /if \(authResult\.status === 503\) return storageUnavailableResponse\(\);/);
  assert.match(main, /if \(isStorageError\(err\)\) return storageUnavailableResponse\(\);/);
  assert.match(main, /\(await servedPlaybackMode\(real\)\) === 'ffmpeg'/);
}

// ---- a library folder serves audio, and nothing else it holds ------------------------
{
  const dir = resolve(root, 'tmp', 'main-protocol-roots');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await build({
    entryPoints: [resolve(root, 'electron/audio-protocol-authorize.ts')],
    bundle: true, format: 'esm', platform: 'node', target: 'es2022',
    outfile: resolve(dir, 'authorize.mjs'), logLevel: 'silent',
  });
  const { authorizeAudioProtocolPath } = await import(pathToFileURL(resolve(dir, 'authorize.mjs')).href);
  const { libraryRootsForRequest } = await load([grab('function libraryRootsForRequest(')], {
    OPEN_AUDIO_EXTS: new Set(['.mp3', '.flac']),
    extname,
  });

  const musicRoot = resolve('/music');
  const urlFor = (path) => new URL(`newamp://track/${encodeURIComponent(path.replace(/\\/g, '/'))}`);
  const authorize = (path, opened = new Set()) => authorizeAudioProtocolPath(urlFor(path), {
    libraryRoots: libraryRootsForRequest(urlFor(path), [musicRoot]),
    openedFiles: opened,
    getPodcastDownloadsRealRoot: async () => null,
    realpath: async (value) => value,
    retry: (op) => op(),
  });

  assert.equal((await authorize(join(musicRoot, 'a', 'song.flac'))).ok, true, 'audio under a library folder plays');
  assert.equal((await authorize(join(musicRoot, 'SONG.MP3'))).ok, true, 'whatever the case of its extension');
  for (const name of ['settings.json', 'notes.txt', 'id_rsa', 'song.mp3.json']) {
    assert.deepEqual(plain(await authorize(join(musicRoot, name))), { ok: false, status: 403 }, `${name} is not served from a library folder`);
  }
  assert.equal((await authorize(resolve('/elsewhere/song.flac'))).ok, false, 'a folder that is not a library folder still serves nothing');
  const opened = join(resolve('/dropped'), 'one.mp3');
  assert.equal((await authorize(opened, new Set([opened]))).ok, true, 'an opened file does not depend on the folders');
  await rm(dir, { recursive: true, force: true });
}

// ---- closing the projector hands throttling back to the playing state --------
{
  const pieces = [
    grab('let backgroundThrottlingFor'),
    grab('function refreshBackgroundThrottling('),
    grab('function restoreMainWindowThrottling('),
  ];
  const set = [];
  const state = { isPlaying: true };
  const context = {
    smokeMode: false,
    shellPlaybackState: state,
    mainWin: { isDestroyed: () => false, webContents: { id: 7, setBackgroundThrottling: (on) => set.push(on) } },
  };
  const { refreshBackgroundThrottling, restoreMainWindowThrottling } = await load(pieces, context);
  refreshBackgroundThrottling();
  assert.deepEqual(set, [false], 'playing turns throttling off');
  restoreMainWindowThrottling();
  assert.equal(set.at(-1), false, 'closing the projector while playing leaves throttling off');
  assert.ok(!set.includes(true), 'it never turned throttling back on mid-playback');
  state.isPlaying = false;
  refreshBackgroundThrottling();
  assert.equal(set.at(-1), true, 'pausing turns it back on');
  restoreMainWindowThrottling();
  assert.equal(set.at(-1), true, 'closing the projector while paused keeps it on');
}

// ---- deck requests run in order ---------------------------------------------
{
  const pieces = [grab('let compactModeChain'), grab('function requestCompactMode(')];
  const order = [];
  const gates = [];
  const context = {
    Promise,
    setCompactMode: (on) => new Promise((resolveCall) => {
      order.push(`start:${on}`);
      gates.push(() => { order.push(`end:${on}`); resolveCall(); });
    }),
  };
  const { requestCompactMode } = await load(pieces, context);
  const first = requestCompactMode(true);
  const second = requestCompactMode(false);
  await new Promise(setImmediate);
  assert.deepEqual(order, ['start:true'], 'the second request waits while the first leaves fullscreen');
  gates.shift()();
  await first;
  await new Promise(setImmediate);
  assert.deepEqual(order, ['start:true', 'end:true', 'start:false'], 'then it runs, last, so its answer stands');
  gates.shift()();
  await second;
}

// ---- opened targets: off the main thread, kept when the share is slow ----------
{
  const pieces = [
    grab('const OPEN_PLAYLIST_EXTS'),
    grab('type PathProbe'),
    grab('const PATH_PROBE_TIMEOUT_MS').replace('3000', '40'),
    grab('const PATH_PROBE_CONCURRENCY'),
    grab('function probePath('),
    grab('async function mapBounded'),
    grab('function openTargetKey('),
    grab('function openArgCandidates('),
    grab('function isOpenableFile('),
    grab('function openTargetKind('),
    grab('const OPEN_TARGET_STAT_CONCURRENCY'),
    grab('async function normalizeOpenTargets('),
    grab('async function collectOpenFileArgs('),
  ];
  const files = new Map();
  const stats = (kind) => ({ isFile: () => kind === 'file', isDirectory: () => kind === 'directory' });
  let inFlight = 0;
  let peak = 0;
  const base = {
    setTimeout, clearTimeout, Promise,
    OPEN_AUDIO_EXTS: new Set(['.flac', '.mp3', '.m4a']),
    extname: (p) => (/\.[^./]+$/.exec(p)?.[0] ?? ''),
    resolve: (...parts) => parts.join('/').replace(/\/+/g, '/'),
    caseFoldCachePath: (p, platform) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p),
    process: { platform: 'linux', defaultApp: false },
    stat: async (path) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((done) => setTimeout(done, 5));
        const entry = files.get(path);
        if (entry === 'hang') await new Promise(() => {});
        if (entry instanceof Error) throw entry;
        if (!entry) throw errno('ENOENT');
        return stats(entry);
      } finally {
        inFlight -= 1;
      }
    },
  };
  const { normalizeOpenTargets, collectOpenFileArgs } = await load(pieces, { ...base });

  files.set('/m/Song.flac', 'file');
  files.set('/m/song.flac', 'file');
  files.set('/m/Album', 'directory');
  files.set('/m/notes.txt', 'file');
  files.set('/m/slow.flac', 'hang');
  files.set('/m/slow.txt', 'hang');
  files.set('/m/io.mp3', errno('EIO'));
  const out = await normalizeOpenTargets(['/m/Song.flac', '/m/song.flac', '/m/Album', '/m/gone.flac', '/m/slow.flac', '/m/slow.txt', '/m/io.mp3', '', 5]);
  assert.deepEqual(
    plain(out),
    [
      { path: '/m/Song.flac', kind: 'file' },
      { path: '/m/song.flac', kind: 'file' },
      { path: '/m/Album', kind: 'directory' },
      { path: '/m/slow.flac', kind: 'file' },
      { path: '/m/io.mp3', kind: 'file' },
    ],
    'Linux keeps two names that differ by case, a missing file is dropped, and an audio file the share did not answer for is kept to be read or reported',
  );
  assert.ok(peak <= 4, `at most four lookups at once (saw ${peak})`);

  const mac = await load(pieces, { ...base, process: { platform: 'darwin', defaultApp: false } });
  const folded = plain(await mac.normalizeOpenTargets(['/m/Song.flac', '/m/song.flac']));
  assert.equal(folded.length, 1, 'macOS and Windows treat names that differ by case as one file');

  // A second launch resolves relative names against where it was typed, and a
  // folder argument comes through along with files.
  files.set('/home/me/music/a.flac', 'file');
  files.set('/home/me/music/albums', 'directory');
  files.set('/home/me/music/readme.txt', 'file');
  const args = await collectOpenFileArgs(['/usr/bin/newamp', '--flag', 'a.flac', 'albums', 'readme.txt', 'newamp://x'], '/home/me/music');
  assert.deepEqual(plain(args), ['/home/me/music/a.flac', '/home/me/music/albums']);
  const dev = await load(pieces, { ...base, process: { platform: 'linux', defaultApp: true } });
  files.set('/app', 'directory');
  files.set('/home/me/music/b.flac', 'file');
  assert.deepEqual(
    plain(await dev.collectOpenFileArgs(['/usr/bin/electron', '/app', 'b.flac'], '/home/me/music')),
    ['/home/me/music/b.flac'],
    'run from source, the app folder on the command line is not something to open',
  );
}

// ---- opened folders: a big one starts playing, a library folder is not re-read ---------
{
  const dir = resolve(root, 'tmp', 'main-open-folder');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await build({
    entryPoints: [resolve(root, 'electron/library-skip.ts')],
    bundle: true, format: 'esm', platform: 'node', target: 'es2022',
    outfile: resolve(dir, 'library-skip.mjs'), logLevel: 'silent',
  });
  const skip = await import(pathToFileURL(resolve(dir, 'library-skip.mjs')).href);

  async function makeFolder(path, count, ext = '.mp3') {
    await mkdir(path, { recursive: true });
    for (let i = 0; i < count; i += 1) await writeFile(join(path, `${String(i).padStart(3, '0')}${ext}`), '');
    return path;
  }
  const within = (ms, promise) => {
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the open waited for the scan')), ms); });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  };

  // openFiles with a library that remembers what is read into it, and a scanner
  // that never answers (a scan queued behind a long one).
  async function session({ libraryRoots = [], walkDirs, unreadable = [] } = {}) {
    const rows = new Map();
    const reads = [];
    const scans = [];
    let nextId = 1;
    const byPath = (a, b) => a.path.localeCompare(b.path, undefined, { numeric: true });
    const context = {
      console, Promise, Set, Map, Array, Infinity, Number, String, setTimeout,
      // A volume that lists a folder in no particular order (NTFS happens to sort).
      readdir: async (...args) => (await readdir(...args)).reverse(),
      join, basename, dirname, extname,
      OPEN_AUDIO_EXTS: skip.AUDIO_EXTS,
      OPEN_PLAYLIST_EXTS: new Set(['.m3u', '.m3u8', '.pls', '.cue']),
      isSkippedLibraryFile: skip.isSkippedLibraryFile,
      isSkippedLibraryFolder: skip.isSkippedLibraryFolder,
      isPathInside: (path, folder) => path === folder || path.startsWith(`${folder}${sep}`),
      errorMessage: String,
      settings: { get: () => ({ libraryRoots }) },
      library: {
        getTracksByPaths: (paths) => paths.filter((path) => rows.has(path)).map((path) => rows.get(path)),
        upsertTracks: (readings) => { for (const reading of readings) rows.set(reading.path, { ...reading, id: nextId++, missingSince: null }); },
        getFolderTracksAsync: async (folder, options) => {
          const inside = [...rows.values()].filter((track) => track.path.startsWith(`${folder}${sep}`)).sort(byPath);
          return inside.slice(0, options.limit);
        },
      },
      scanner: { start: (folders) => { scans.push(folders); return new Promise(() => {}); } },
      readTrackFile: async (path) => { reads.push(path); return unreadable.includes(path) ? null : { path, title: basename(path) }; },
      retryStorageErrors: (op) => op(),
      normalizeOpenTargets: async (paths) => paths.map((path) => ({ path, kind: statSync(path).isDirectory() ? 'directory' : 'file' })),
      allowOpenedAudioFile: async () => {},
      recordRecentDocuments() {},
    };
    const walkLimit = grab('const OPENED_FOLDER_WALK_DIRS');
    const pieces = [
      grab('const UNREAD_OPEN_REASON'),
      grab('const OPENED_FILE_READS'),
      grab('const OPENED_FOLDER_INLINE_FILES'),
      walkDirs === undefined ? walkLimit : walkLimit.replace('5000', String(walkDirs)),
      grab('const OPENED_FILE_RETRY_MS').replace('500', '1'),
      grab('async function readOpenedFiles('),
      grab('function isInsideLibraryRoot('),
      grab('async function listAudioFiles('),
      grab('async function readOpenedFolders('),
      grab('async function openFiles('),
    ];
    const { openFiles } = await load(pieces, context);
    return { openFiles, reads, scans, rows, seed: (path) => rows.set(path, { path, id: nextId++, missingSince: null }) };
  }
  const named = (tracks) => plain(tracks.map((track) => track.path));

  // 301 files in one folder, outside every library folder: the first 300 are
  // read and come back to play, the scanner is handed the folder, and the open
  // does not wait for it.
  const flat = await makeFolder(join(dir, 'flat'), 301);
  {
    const s = await session();
    const result = await within(5000, s.openFiles([flat]));
    assert.equal(result.tracks.length, 300, 'a folder over the inline limit still plays');
    assert.deepEqual(plain(result.skipped), []);
    assert.equal(s.reads.length, 300, 'the 301st file is left unread until the first track plays');
    assert.equal(result.tracks[0].path, join(flat, '000.mp3'));
    assert.equal(result.tracks.at(-1).path, join(flat, '299.mp3'), 'the files read are the first by name');
    assert.deepEqual(plain(s.scans), [[flat]], 'the scanner gets the folder to bring in the rest');
    assert.equal(result.leftToScanner, 1, 'the page is told how many files were left to the scanner');
  }
  // Spread over folders, the first ones by name are read, the same ones each time.
  const nested = join(dir, 'nested');
  for (const album of ['c', 'a', 'b']) await makeFolder(join(nested, `album ${album}`), 150);
  {
    const s = await session();
    const result = await within(5000, s.openFiles([nested]));
    assert.equal(result.tracks.length, 300);
    assert.deepEqual(
      [...new Set(named(result.tracks).map((path) => basename(dirname(path))))].sort(),
      ['album a', 'album b'],
      'albums are taken in name order',
    );
    assert.equal(result.leftToScanner, 150, 'the third album was not read');
  }
  // At and under the limit the whole folder is read.
  for (const count of [299, 300]) {
    const s = await session();
    const folder = await makeFolder(join(dir, `exactly-${count}`), count);
    const result = await within(5000, s.openFiles([folder]));
    assert.equal(result.tracks.length, count);
    assert.equal(s.reads.length, count);
    assert.deepEqual(plain(s.scans), [[folder]], 'the scanner still refreshes it behind the open');
    assert.equal(result.leftToScanner, undefined, 'nothing was left when the whole folder was read');
  }
  // A folder in a library folder that already has tracks comes from the library.
  {
    const s = await session({ libraryRoots: [dir] });
    s.seed(join(flat, '000.mp3'));
    s.seed(join(flat, '001.mp3'));
    const result = await within(5000, s.openFiles([flat]));
    assert.deepEqual(named(result.tracks), [join(flat, '000.mp3'), join(flat, '001.mp3')]);
    assert.equal(s.reads.length, 0, 'nothing already in the library is read from the share');
    assert.equal(result.leftToScanner, undefined);
    assert.deepEqual(plain(s.scans), [[flat]]);
  }
  // In a library folder but unknown to the library, it is read like any other.
  {
    const s = await session({ libraryRoots: [dir] });
    const folder = await makeFolder(join(dir, 'fresh'), 5);
    const result = await within(5000, s.openFiles([folder]));
    assert.equal(result.tracks.length, 5);
    assert.equal(s.reads.length, 5);
  }
  // A file that will not read is listed as skipped while the folder's others play.
  {
    const folder = await makeFolder(join(dir, 'one-bad'), 4);
    const failing = join(folder, '002.mp3');
    const s = await session({ unreadable: [failing] });
    const result = await within(5000, s.openFiles([folder]));
    assert.equal(result.tracks.length, 3);
    assert.equal(result.skipped.length, 1);
    assert.ok(result.skipped[0].startsWith(`${failing}: could not be read`), result.skipped[0]);
  }
  // Something that is not a list is turned away before anything walks it.
  {
    const s = await session();
    for (const bad of ['/music', { length: 3 }, null, 7]) {
      assert.deepEqual(plain(await s.openFiles(bad)), { tracks: [], importedPlaylists: [], skipped: [] });
    }
    assert.equal(s.reads.length, 0);
    assert.equal(s.scans.length, 0);
  }
  // A walk through a tree with little audio gives up after the folder cap.
  {
    const s = await session({ walkDirs: 3 });
    const deep = join(dir, 'deep');
    for (let i = 1; i <= 8; i += 1) await makeFolder(join(deep, `d${String(i).padStart(2, '0')}`), 1);
    const result = await within(5000, s.openFiles([deep]));
    assert.equal(result.tracks.length, 2, 'the walk looked into three folders: the root and the first two inside it');
    assert.deepEqual(plain(s.scans), [[deep]], 'the scanner has the whole tree');
  }
  await rm(dir, { recursive: true, force: true });
}

// ---- watched targets: only "no such file" counts as gone -----------------------
{
  const pieces = [
    grab('type PathProbe'),
    grab('const PATH_PROBE_TIMEOUT_MS').replace('3000', '40'),
    grab('function probePath('),
    grab('async function mapBounded'),
    'this.mapBounded = mapBounded;',
  ];
  const present = new Set(['/local/here.flac']);
  let inFlight = 0;
  let peak = 0;
  const context = {
    setTimeout, clearTimeout, Promise,
    stat: async (path) => {
      if (path.startsWith('/share/')) await new Promise(() => {});
      if (present.has(path)) return {};
      throw errno(path.endsWith('/denied.flac') ? 'EACCES' : path.endsWith('/file.flac/x') ? 'ENOTDIR' : 'ENOENT');
    },
  };
  const { probePath } = await load(pieces, context);
  const { mapBounded } = context;
  assert.equal((await probePath('/local/here.flac')).presence, 'present');
  assert.equal((await probePath('/local/gone.flac')).presence, 'missing', 'no such file is an answer');
  assert.equal((await probePath('/local/file.flac/x')).presence, 'missing', 'a file where a folder was expected is an answer');
  assert.equal((await probePath('/local/denied.flac')).presence, 'unknown', 'a permission error is not a missing file');
  assert.equal((await probePath('/share/a/slow.flac')).presence, 'unknown', 'a share that never answers is not a missing file');

  const results = await mapBounded([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((done) => setTimeout(done, 5));
    inFlight -= 1;
    return n * 2;
  });
  assert.deepEqual(plain(results), [2, 4, 6, 8, 10, 12, 14], 'results keep the order of the items');
  assert.ok(peak <= 3, 'no more than the limit run at once');

  // markTracksMissingAsync (library.ts) is tri-state and marks nothing for a
  // target that did not answer; main only has to hand it every watched target.
  const reconcile = grab('function reconcileWatchedTargets(');
  assert.match(reconcile, /await library\.markTracksMissingAsync\(watched\)/, 'the watcher marks through the storage-aware call');
  assert.doesNotMatch(reconcile, /existsSync/, 'and does not ask the main thread whether a path exists');
}

// ---- spreadsheet cells and file names ----------------------------------------------
{
  const { csvCell } = await load([grab('function csvCell(')], { String });
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`, 'a formula in a tag is made text');
  for (const lead of ['+', '-', '@', '\t', '\r']) assert.ok(csvCell(`${lead}1`).startsWith(`'`) || csvCell(`${lead}1`).startsWith(`"'`), `a cell led by ${JSON.stringify(lead)} is quoted`);
  assert.equal(csvCell(-6.5), '-6.5', 'a negative number stays a number');
  assert.equal(csvCell('Plain'), 'Plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(null), '');
}
{
  const pieces = [grab('const RESERVED_FILE_STEMS'), grab('const MAX_FILE_STEM_LENGTH'), grab('function safeFileStem(')];
  const { safeFileStem } = await load(pieces, {});
  assert.equal(safeFileStem('CON'), '_CON');
  assert.equal(safeFileStem('nul'), '_nul');
  assert.equal(safeFileStem('Mix.'), 'Mix');
  assert.equal(safeFileStem('  Road: Trip? '), 'Road_ Trip_');
  assert.equal(safeFileStem('x'.repeat(300)).length, 120);
  assert.equal(safeFileStem('...'), 'NewAmp Playlist');
  assert.equal(safeFileStem('Console'), 'Console');
  assert.equal(safeFileStem('CON.x'), '_CON.x', 'Windows takes everything before the first dot for the device name');
  assert.equal(safeFileStem('nul.backup'), '_nul.backup');
  assert.equal(safeFileStem('com1 .v2'), '_com1 .v2');
  assert.equal(safeFileStem('Mix.con'), 'Mix.con', 'a device name after the dot is just a name');
  assert.equal(safeFileStem('v1.2 mix'), 'v1.2 mix');
}

// ---- the Dock menu names what is loaded ---------------------------------------------
{
  const pieces = [grab('function nowPlayingLabel('), grab('function buildDockMenu(')];
  const state = { isPlaying: false, title: null, artist: null };
  const sent = [];
  const context = {
    shellPlaybackState: state,
    Menu: { buildFromTemplate: (template) => template },
    showMainWindow() {},
    sendPlayerCommand: (command) => sent.push(command),
  };
  const { buildDockMenu } = await load(pieces, context);
  assert.deepEqual(plain(buildDockMenu().map((item) => item.label)), ['Show NewAmp'], 'with nothing loaded there is no Play or Next to press');
  Object.assign(state, { title: 'Spoon', artist: 'Wilco', isPlaying: true });
  const loaded = buildDockMenu();
  assert.equal(loaded[0].label, 'Spoon - Wilco');
  assert.equal(loaded[0].enabled, false, 'the track line is a label, not a command');
  assert.deepEqual(plain(loaded.filter((item) => item.label).slice(1).map((item) => item.label)), ['Previous', 'Pause', 'Next', 'Stop', 'Show NewAmp']);
  for (const item of loaded) item.click?.();
  assert.deepEqual(plain(sent), ['previous', 'toggle-play', 'next', 'stop'], 'Play/Pause and Next send their commands');
  Object.assign(state, { artist: null, isPlaying: false });
  assert.equal(buildDockMenu()[0].label, 'Spoon');
  assert.equal(buildDockMenu()[3].label, 'Play');
}

// ---- exclusive and gapless sources: the tags are read within a limit ------------------------
{
  const rows = new Map([
    [1, { path: '/m/a.flac', mtime: 10, sampleRate: 44100, duration: 200, codec: 'FLAC' }],
    [2, { path: '/m/b.ogg', mtime: 11, sampleRate: 44100, duration: 180, codec: 'Opus' }],
    [3, { path: '/m/c.ogg', mtime: 12, sampleRate: 44100, duration: 150, codec: 'Vorbis' }],
  ]);
  const pieces = [
    grab('const exclusiveSourceCache'),
    grab('const OPUS_DECODE_RATE'),
    grab('function isOpusCodec('),
    grab('function exclusiveSourceFromLibrary('),
    grab('const EXCLUSIVE_PROBE_TIMEOUT_MS').replace('2000', '40'),
    grab('async function probeExclusiveSource(').replace("import('music-metadata')", 'musicMetadata()'),
    grab('async function resolveExclusiveSource('),
    grab('async function resolveGaplessSource('),
  ];
  let behaviour = () => Promise.resolve({ format: {} });
  let parses = 0;
  const context = {
    Map, Promise, setTimeout, clearTimeout,
    library: { getTrack: (id) => rows.get(id) ?? null },
    classifyTrackSource: (path) => ({ lossless: /\.(flac|wav)$/.test(path), dsd: false }),
    isStorageError: (err) => err?.code === 'ETIMEDOUT',
    musicMetadata: async () => ({ parseFile: () => { parses += 1; return behaviour(); } }),
  };
  const { exclusiveSourceCache, resolveExclusiveSource, resolveGaplessSource } = await load(pieces, context);
  const reset = () => { exclusiveSourceCache.clear(); parses = 0; };
  const hang = () => new Promise(() => {});
  const flacFormat = { format: { bitsPerSample: 24, numberOfChannels: 2, sampleRate: 96000, lossless: true, codec: 'FLAC' } };

  behaviour = () => Promise.resolve(flacFormat);
  const read = plain(await resolveExclusiveSource(1));
  assert.deepEqual([read.bitDepth, read.channels, read.sampleRate, read.lossless], [24, 2, 96000, true], 'the file\'s own format is used when it answers');
  await resolveExclusiveSource(1);
  assert.equal(parses, 1, 'and kept for the next play');
  assert.equal(await resolveExclusiveSource(99), null, 'a track the library does not have does not resolve');

  // A read that never answers: the play goes on from the library row.
  reset();
  behaviour = hang;
  const started = Date.now();
  const stuck = plain(await resolveExclusiveSource(1));
  assert.ok(Date.now() - started < 1000, 'the play is not held for a read that never answers');
  assert.deepEqual([stuck.path, stuck.sampleRate, stuck.durationSec, stuck.bitDepth, stuck.lossless], ['/m/a.flac', 44100, 200, null, true]);
  await resolveExclusiveSource(1);
  assert.equal(parses, 2, 'what the row stood in for is not kept: the next play reads again');

  // Tags that are slow but do arrive: this play uses the row, the next the file.
  reset();
  behaviour = () => new Promise((done) => setTimeout(() => done(flacFormat), 120));
  assert.equal(plain(await resolveExclusiveSource(1)).bitDepth, null, 'the play does not wait for slow tags');
  await new Promise((done) => setTimeout(done, 250));
  assert.equal(plain(await resolveExclusiveSource(1)).bitDepth, 24, 'a late answer is kept for the next play');
  assert.equal(parses, 1);

  // A share that timed out is not kept; a file that will not parse is.
  reset();
  behaviour = () => Promise.reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
  await resolveExclusiveSource(1);
  await resolveExclusiveSource(1);
  assert.equal(parses, 2);
  reset();
  behaviour = () => Promise.reject(new Error('not a flac'));
  assert.equal(plain(await resolveExclusiveSource(1)).sampleRate, 44100);
  await resolveExclusiveSource(1);
  assert.equal(parses, 1);

  // Opus decodes at 48 kHz whatever its header says, from the file or from the row.
  reset();
  behaviour = () => Promise.resolve({ format: { sampleRate: 44100, codec: 'Opus', lossless: false } });
  assert.equal(plain(await resolveExclusiveSource(2)).sampleRate, 48000, 'Ogg Opus read from the file');
  reset();
  behaviour = hang;
  assert.equal(plain(await resolveExclusiveSource(2)).sampleRate, 48000, 'Ogg Opus from the library row');
  reset();
  behaviour = () => Promise.resolve({ format: { sampleRate: 44100, codec: 'Vorbis', lossless: false } });
  assert.equal(plain(await resolveExclusiveSource(3)).sampleRate, 44100, 'Ogg Vorbis keeps its own rate');

  // Gapless never reads the file.
  reset();
  behaviour = hang;
  const gapless = plain(await resolveGaplessSource(1));
  assert.deepEqual([gapless.trackId, gapless.path, gapless.durationSec, gapless.dsd], [1, '/m/a.flac', 200, false]);
  assert.equal(await resolveGaplessSource(99), null);
  assert.equal(parses, 0, 'no tags are read for a gapless start');
}

// ---- quitting: each step stands alone, and a quit held open writes the settings again ----
{
  const fromWillQuit = main.slice(main.indexOf("app.on('will-quit', (event) => {"));
  const handlerSource = fromWillQuit.slice(0, fromWillQuit.indexOf('\n});\n') + 4);
  const { code } = await transform(`let willQuitTeardownDone = false;\n${handlerSource}`, { loader: 'ts', target: 'es2022' });

  const make = ({ failing, radioBrain = null }) => {
    const calls = [];
    const step = (name) => () => {
      calls.push(name);
      if (failing) throw new Error(`${name} failed`);
    };
    let handler;
    const context = {
      console: { error() {}, warn() {} },
      Promise,
      displaySleepBlockerId: 7, appSuspensionBlockerId: 8,
      powerSaveBlocker: { stop: (id) => calls.push(`unblock:${id}`) },
      globalShortcut: { unregisterAll: step('shortcuts') },
      closeStartupSplashWindow: step('splash'),
      libraryWatcher: { stop: step('watcher') },
      scanner: { cancel: step('scanner') },
      libraryAnalysis: { stop: step('analysis') },
      library: { close: step('library') },
      settings: { flushSync: step('settings') },
      podcastStore: { flushProgressSync: step('podcasts') },
      exclusiveOutput: { dispose: step('exclusive') },
      tray: { destroy: step('tray') },
      killAllDnaFfmpeg: step('dna'), killAllAnalysisFfmpeg: step('analysis-ffmpeg'), killAllScoreFfmpeg: step('score'),
      killAllWaveformFfmpeg: step('waveform'), killAllTranscodeFfmpeg: step('transcode'), closeAllGaplessSessions: step('gapless'),
      radioBrain, radioBrainShutdownStarted: false,
      app: { on: (name, fn) => { if (name === 'will-quit') handler = fn; }, quit: () => handler({ preventDefault() {} }) },
    };
    vm.runInNewContext(code, context);
    return { calls, quit: (event = { preventDefault() {} }) => handler(event) };
  };

  // Whatever fails, the steps after it still run.
  const failing = make({ failing: true });
  failing.quit();
  const steps = ['shortcuts', 'splash', 'watcher', 'scanner', 'analysis', 'library', 'settings', 'podcasts', 'exclusive', 'tray', 'dna', 'analysis-ffmpeg', 'score', 'waveform', 'transcode', 'gapless'];
  assert.deepEqual(plain(failing.calls.filter((name) => !name.startsWith('unblock'))), steps, 'every step is tried, in order, though each one throws');
  assert.deepEqual(plain(failing.calls.filter((name) => name.startsWith('unblock'))), ['unblock:7', 'unblock:8']);

  // A radio brain holds the quit open and quits again: the library is closed
  // once, the settings are written on both passes.
  let release;
  const held = make({ failing: false, radioBrain: { stop: () => new Promise((done) => { release = done; }) } });
  let prevented = 0;
  held.quit({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1, 'the first pass holds the quit open');
  release();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(held.calls.filter((name) => name === 'library').length, 1, 'the library is closed once');
  assert.equal(held.calls.filter((name) => name === 'settings').length, 2, 'the settings are flushed again on the pass after the hold');
  assert.equal(held.calls.filter((name) => name === 'tray').length, 1);
}

// ---- files opened together: names that differ by case are two files only where the volume says so ----
{
  const dir = resolve(root, 'tmp', 'main-open-batcher');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await build({
    entryPoints: [resolve(root, 'electron/open-file-batcher.ts')],
    bundle: true, format: 'esm', platform: 'node', target: 'es2022',
    outfile: resolve(dir, 'batcher.mjs'), logLevel: 'silent',
  });
  const { createOpenFileBatcher, mergeHandedOff } = await import(pathToFileURL(resolve(dir, 'batcher.mjs')).href);

  async function opened(platform, batches, handedOff = null) {
    const sent = [];
    const context = {
      createOpenFileBatcher, mergeHandedOff, Date, Set, setTimeout, clearTimeout,
      process: { platform },
      caseFoldCachePath: (path, name) => (name === 'win32' || name === 'darwin' ? path.toLowerCase() : path),
      mainWin: { isDestroyed: () => false, webContents: { isLoading: () => false, send: (channel, files) => sent.push([channel, files]) } },
      pendingOpenFiles: [],
    };
    const { openFileBatcher } = await load([
      grab('function openTargetKey('),
      grab('const COLD_START_MERGE_MS'),
      `let handedOffFiles: unknown = ${JSON.stringify(handedOff)};`,
      grab('const openFileBatcher').replace('quietMs: 400', 'quietMs: 15'),
      grab('function deliverOpenFiles('),
    ], context);
    for (const batch of batches) openFileBatcher.push(batch);
    await openFileBatcher.settled();
    openFileBatcher.dispose();
    return plain(sent);
  }

  const both = ['/m/A.mp3', '/m/a.mp3'];
  assert.deepEqual(await opened('linux', [both]), [['app:open-files', both]], 'on a case-sensitive volume both files are opened');
  assert.deepEqual(await opened('darwin', [both]), [['app:open-files', ['/m/A.mp3']]], 'on macOS and Windows they are one file');
  assert.deepEqual(await opened('linux', [['/m/A.mp3'], ['/m/a.mp3', '/m/A.mp3']]), [['app:open-files', both]], 'across events too, and an exact repeat is still one');
  // The file the page took at launch is carried into the batch that follows.
  const taken = { paths: ['/m/A.mp3'], at: Date.now() };
  assert.deepEqual(await opened('linux', [['/m/a.mp3']], taken), [['app:open-files', both]], 'a hand-off merges by the same rule: two files on Linux');
  assert.deepEqual(await opened('darwin', [['/m/a.mp3']], taken), [['app:open-files', ['/m/A.mp3']]], 'and one on macOS and Windows');
  await rm(dir, { recursive: true, force: true });
}

// ---- what a tag may put into the shell, and the pause around a Mac's sleep ----------------
{
  const pieces = [
    grab('const SHELL_TEXT_MAX_CHARS'),
    grab('function sanitizeShellText('),
    grab('let shellPlaybackState'),
    grab('let sleepPauseUntil'),
    grab('const WAKE_PAUSE_WINDOW_MS'),
    grab('const shellPlaybackSubscribers'),
    grab('function applyShellPlaybackState('),
    grab('function pauseForSleep('),
    grab('function noteWake('),
    'this.currentState = () => shellPlaybackState;',
  ];
  let clock = 1_000;
  const sent = [];
  const tips = [];
  const calls = { watcher: 0, exclusivePaused: 0 };
  const context = {
    Date: { now: () => clock },
    Set, Array, Infinity, console,
    sendPlayerCommand: (command) => sent.push(command),
    applyThumbarButtons() {}, refreshDockMenu() {}, refreshDisplaySleepBlocker() {},
    refreshBackgroundThrottling() {}, syncMediaShortcuts() {}, retryDeferredDailyBackup() {},
    syncLibraryWatcher: () => { calls.watcher += 1; },
    exclusiveOutput: { pause: () => { calls.exclusivePaused += 1; } },
    tray: { isDestroyed: () => false, setToolTip: (text) => tips.push(text) },
  };
  const { sanitizeShellText, applyShellPlaybackState, pauseForSleep, noteWake } = await load(pieces, context);
  const bidi = String.fromCharCode(0x202e, 0x2066);
  const snapshot = (over = {}) => ({ isPlaying: true, title: 'Spoon', artist: 'Wilco', album: null, trackId: 1, position: 0, duration: 200, volume: 0.5, at: clock, ...over });

  assert.equal(sanitizeShellText(`Sp${bidi}oon\n\t  Remix\u0007`), 'Sp oon Remix', 'controls and direction overrides go, whitespace collapses');
  assert.equal(sanitizeShellText('x'.repeat(10_000)).length, 200, 'a tag of any length is capped');
  assert.equal(Array.from(sanitizeShellText('\u{1F3B5}'.repeat(500))).length, 200, 'the cap counts characters, not halves of a pair');
  assert.equal(sanitizeShellText(' \n '), null);
  assert.equal(sanitizeShellText(42), null);
  assert.equal(sanitizeShellText('Sigur Rós – Hoppípolla'), 'Sigur Rós – Hoppípolla', 'ordinary text is left alone');

  applyShellPlaybackState(snapshot({ title: `${bidi}Title\nwith break`, artist: 'a'.repeat(5000), album: '\u0001' }));
  const state = context.currentState();
  assert.equal(state.title, 'Title with break');
  assert.equal(state.artist.length, 200);
  assert.equal(state.album, null);
  assert.ok(tips.at(-1).length < 500 && !tips.at(-1).includes(bidi[0]), 'the tray tooltip carries the cleaned text');
  sent.length = 0;

  // Sleeping while playing: paused at once, and a page that starts the sound
  // again on wake is paused once.
  clock = 10_000;
  applyShellPlaybackState(snapshot());
  assert.deepEqual(sent, []);
  pauseForSleep();
  assert.deepEqual(plain(sent), ['pause']);
  assert.equal(calls.exclusivePaused, 1, 'native output is paused directly');
  assert.equal(context.currentState().isPlaying, false, 'the snapshot says paused');
  clock = 20_000;
  applyShellPlaybackState(snapshot());
  assert.deepEqual(plain(sent), ['pause', 'pause'], 'asleep, a snapshot that says playing is paused again');
  clock = 60_000;
  noteWake();
  assert.equal(calls.watcher, 1, 'a wake looks at the library folders again');
  clock = 61_000;
  applyShellPlaybackState(snapshot());
  assert.deepEqual(plain(sent), ['pause', 'pause', 'pause'], 'the page starting itself on wake is paused');
  clock = 61_500;
  applyShellPlaybackState(snapshot());
  assert.equal(sent.length, 3, 'a play pressed after that correction is left alone');

  // Past the window, a snapshot that says playing is the listener's.
  pauseForSleep();
  clock = 70_000;
  noteWake();
  clock = 70_000 + 3_001;
  applyShellPlaybackState(snapshot());
  assert.equal(sent.length, 4, 'one pause from the sleep itself and none after the window');

  // Nothing was playing at sleep: a play after the wake is the listener's.
  applyShellPlaybackState(snapshot({ isPlaying: false }));
  sent.length = 0;
  pauseForSleep();
  noteWake();
  clock += 100;
  applyShellPlaybackState(snapshot());
  assert.deepEqual(plain(sent), [], 'no window opens for a Mac that was not playing');
}

// ---- Open Recent is the Mac's list, and a big drop adds only its first files -------------
{
  const added = [];
  const recorder = (platform, smokeMode = false, fail = () => false) => load(
    [grab('const RECENT_DOCUMENTS_MAX'), grab('function recordRecentDocuments(')],
    { smokeMode, process: { platform }, app: { addRecentDocument: (path) => { if (fail(path)) throw new Error('shell busy'); added.push(path); } } },
  );
  const paths = Array.from({ length: 50 }, (_, i) => `/m/${i}.mp3`);
  (await recorder('darwin')).recordRecentDocuments(paths);
  assert.deepEqual(plain(added), paths.slice(0, 20), 'the Mac list gets the first twenty');
  for (const platform of ['win32', 'linux']) {
    added.length = 0;
    (await recorder(platform)).recordRecentDocuments(paths);
    assert.equal(added.length, 0, `${platform} keeps no Recent list for opened files`);
  }
  (await recorder('darwin', true)).recordRecentDocuments(paths);
  assert.equal(added.length, 0, 'a smoke run leaves the list alone');
  (await recorder('darwin', false, (path) => path === '/m/2.mp3')).recordRecentDocuments(paths.slice(0, 5));
  assert.deepEqual(plain(added), ['/m/0.mp3', '/m/1.mp3', '/m/3.mp3', '/m/4.mp3'], 'one the shell refuses does not stop the rest');
}

// ---- the guitar tab window transposes in its page, and an odd token cannot stall it -----
{
  const { renderGuitarTabWindowHtml } = await load(
    [grab('function renderGuitarTabWindowHtml('), grab('function escapeHtml('), grab('function safeJsonForScript(')],
    { JSON, String, Number },
  );
  const odd = `Am${'mM'.repeat(28)}z`;
  const tab = {
    source: 'local', kind: 'chords', url: '', artist: 'Wilco', title: 'Spoon', key: null, rating: null, votes: null,
    lines: [
      { type: 'chords', text: 'C# F#m Am7 G/B Bb' },
      { type: 'lyrics', text: 'Come home to Bb' },
      { type: 'chords', text: odd },
    ],
  };
  const html = renderGuitarTabWindowHtml(tab, false);
  const script = /<script>\n([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'the page carries its script');
  const data = /<script id="tab-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];

  const elements = new Map();
  // Setting a node's text drops its children, as in a page.
  const element = () => ({
    text: '', className: '', children: [], listeners: {}, value: '1.2', checked: false, scrollTop: 0,
    get textContent() { return this.text; },
    set textContent(value) { this.text = value; this.children = []; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild(child) { this.children.push(child); },
  });
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  byId('tab-data').textContent = data;
  vm.runInNewContext(script, {
    document: { getElementById: byId, createElement: element },
    window: { setInterval: () => 0, clearInterval() {} },
    JSON, Map, String, Number, Math,
  });
  const rows = () => plain(byId('lines').children.map((row) => row.textContent));
  assert.deepEqual(rows().slice(0, 2), ['C# F#m Am7 G/B Bb', 'Come home to Bb']);

  byId('up').listeners.click();
  const started = Date.now();
  const up = rows();
  assert.deepEqual(up.slice(0, 2), ['D Gm A#m7 G#/C B', 'Come home to Bb'], 'sharps move whole, and only chord lines change');
  byId('down').listeners.click();
  byId('down').listeners.click();
  assert.equal(rows()[0], 'C Fm G#m7 F#/A# A', 'one step below where it began');
  assert.ok(Date.now() - started < 500, `a long run of qualities takes ${Date.now() - started} ms to transpose`);
  byId('reset').listeners.click();
  assert.equal(rows()[2], odd, 'reset puts the line back');
}

// ---- the window follows the page title, cleaned ---------------------------------------
{
  const handlers = {};
  const titles = [];
  const win = { on: (name, handler) => { handlers[name] = handler; }, setTitle: (title) => titles.push(title) };
  const { followPageTitle } = await load(
    [grab('const SHELL_TEXT_MAX_CHARS'), grab('function sanitizeShellText('), grab('function followPageTitle(')],
    { Array },
  );
  followPageTitle(win);
  let prevented = 0;
  handlers['page-title-updated']({ preventDefault: () => { prevented += 1; } }, `Spoon - Wilco${String.fromCharCode(0x202e)}\n`);
  handlers['page-title-updated']({ preventDefault: () => { prevented += 1; } }, '   ');
  assert.equal(prevented, 2, 'the default title change is replaced');
  assert.deepEqual(plain(titles), ['Spoon - Wilco', 'NewAmp'], 'a title with nothing left is the app name');
}

// ---- a settings file or a library that cannot be written is told to the user ----------
{
  const shown = [];
  const context = {
    smokeMode: false,
    mainWin: { isDestroyed: () => false },
    dialog: { showMessageBox: (...args) => { shown.push(args); return Promise.resolve({ response: 0 }); } },
  };
  const { reportSettingsNotSaved, reportLibraryNotSaved } = await load(
    [grab('function showWarning('), grab('function reportSettingsNotSaved('), grab('function reportLibraryNotSaved(')],
    context,
  );
  const event = { store: 'settings', filePath: '/u/settings.json', backupPath: '/u/settings.json', reason: 'ENOSPC: no space left on device', recoveredAt: 1 };
  reportSettingsNotSaved(event);
  assert.equal(shown.length, 1);
  assert.equal(shown[0][0], context.mainWin, 'it is shown over the window');
  assert.match(shown[0][1].detail, /ENOSPC: no space left on device/, 'with the reason the disk gave');
  assert.equal(shown[0][1].type, 'warning');

  context.mainWin = { isDestroyed: () => true };
  reportSettingsNotSaved(event);
  assert.equal(shown[1].length, 1, 'a window that is gone is not used as the parent');
  context.mainWin = null;
  reportSettingsNotSaved(event);
  assert.equal(shown[2].length, 1, 'neither is a window that does not exist yet');
  context.smokeMode = true;
  reportSettingsNotSaved(event);
  assert.equal(shown.length, 3, 'a smoke run has nobody to click it away');

  // The library's notice says what is at risk, over the window like the other.
  context.smokeMode = false;
  context.mainWin = { isDestroyed: () => false };
  const libraryEvent = { ...event, store: 'library', filePath: '/u/library.db', backupPath: '/u/library.db', reason: 'EACCES: permission denied' };
  reportLibraryNotSaved(libraryEvent);
  assert.equal(shown.length, 4);
  assert.equal(shown[3][0], context.mainWin);
  assert.deepEqual(
    [shown[3][1].type, shown[3][1].title, shown[3][1].message],
    ['warning', 'Library not saved', 'NewAmp could not save your library.'],
  );
  assert.match(shown[3][1].detail, /EACCES: permission denied/, 'with the reason the disk gave');
  assert.match(shown[3][1].detail, /Ratings, plays, playlists and new tracks since the last successful save/, 'and what is at risk');
  context.smokeMode = true;
  reportLibraryNotSaved(libraryEvent);
  assert.equal(shown.length, 4, 'also silent in a smoke run');
}

// ---- the File menu --------------------------------------------------------------------
{
  const dir = resolve(root, 'tmp', 'a1-app-menu-build');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await build({
    entryPoints: [resolve(root, 'electron/app-menu.ts')],
    bundle: true, format: 'esm', platform: 'node', target: 'es2022',
    outfile: resolve(dir, 'app-menu.mjs'), logLevel: 'silent',
  });
  const { buildAppMenuTemplate } = await import(pathToFileURL(resolve(dir, 'app-menu.mjs')).href);
  const calls = [];
  const options = { appName: 'NewAmp', appVersion: '1', isPackaged: true, files: { onOpenFiles: () => calls.push('open'), onAddFolder: () => calls.push('folder') } };
  const mac = buildAppMenuTemplate('darwin', options);
  const labels = mac.map((item) => item.label ?? item.role);
  assert.deepEqual(labels.slice(0, 3), ['NewAmp', 'File', 'editMenu'], 'File sits between the app menu and Edit');
  const file = mac.find((item) => item.label === 'File').submenu;
  const open = file.find((item) => item.accelerator === 'CmdOrCtrl+O');
  const add = file.find((item) => item.accelerator === 'CmdOrCtrl+Shift+O');
  assert.ok(open && /^Open/.test(open.label), 'Open on Cmd+O');
  assert.ok(add && /Add Folder to Library/.test(add.label), 'Add Folder to Library on Cmd+Shift+O');
  open.click(); add.click();
  assert.deepEqual(calls, ['open', 'folder']);
  const recent = file.find((item) => item.role === 'recentDocuments');
  assert.ok(recent, 'Open Recent is the system list');
  assert.deepEqual(recent.submenu.map((item) => item.role), ['clearRecentDocuments'], 'with a Clear Menu item');
  assert.ok(!buildAppMenuTemplate('darwin', { ...options, files: undefined }).some((item) => item.label === 'File'), 'no File menu without handlers');
  assert.deepEqual(buildAppMenuTemplate('win32', options), [], 'Windows and Linux keep the chromeless window with no menu');
  assert.deepEqual(buildAppMenuTemplate('linux', options), []);
  await rm(dir, { recursive: true, force: true });
}

// ---- source pins -----------------------------------------------------------------------
{
  // Only the app's own pages may load in a window that carries the preload bridge.
  assert.match(grab('function attachExternalLinkHandler('), /if \(isAppUrl\(url\)\) return;\s*event\.preventDefault\(\);\s*if \(isExternalUrl\(url\)\) void shell\.openExternal\(url\);/);
  const { isAppUrl } = await load([grab('function isAppUrl(')], { URL, isDev: false });
  assert.equal(isAppUrl('newamp-app://app/index.html'), true);
  assert.equal(isAppUrl('file:///Users/x/evil.html'), false);
  assert.equal(isAppUrl('newamp-app://other/'), false);
  assert.equal(isAppUrl('http://localhost:5173/'), false);
  assert.equal((await load([grab('function isAppUrl(')], { URL, isDev: true })).isAppUrl('http://localhost:5173/x'), true, 'the dev server in development');
  assert.equal(isAppUrl('not a url'), false);

  // Static assets are typed and not sniffed.
  const mime = grab('function rendererMimeType(');
  for (const ext of ['.webp', '.wasm', '.woff', '.ttf', '.gif', '.mjs', '.map']) assert.ok(mime.includes(`'${ext}'`), `${ext} has a type`);
  assert.match(main, /'X-Content-Type-Options': 'nosniff'/);

  // Only audio is let through to the audio protocol.
  const open = grab('async function openFiles(');
  assert.match(open, /await Promise\.all\(audioPaths\.map\(\(path\) => allowOpenedAudioFile\(path\)\)\);/);
  assert.doesNotMatch(open, /targets\.filter\(\(target\) => target\.kind === 'file'\)\.map\(\(target\) => allowOpenedAudioFile/);
  assert.ok(open.indexOf('audioPaths.push') < open.indexOf('allowOpenedAudioFile'), 'the extension is read before anything is authorized');
  assert.match(open, /\.filter\(\(path\) => OPEN_AUDIO_EXTS\.has\(extname\(path\)\.toLowerCase\(\)\)\)/, 'a CUE sheet cannot name a file that is not audio');
  assert.match(open, /library\.getFolderTracksAsync\(folderPath/, 'a dropped folder is read in slices');
  assert.doesNotMatch(open, /await scanner\.start\(folderPaths\)/, 'a dropped folder does not wait behind the running scan');
  assert.match(grab('async function enqueueOpenFiles('), /kind === 'file' && OPEN_AUDIO_EXTS\.has/);

  // An opened file the library already holds is not parsed again.
  assert.match(grab('async function readOpenedFiles('), /library\.getTracksByPaths\(\[path\]\)\.some\(\(track\) => !track\.missingSince\)/);

  // A crashed page does not leave the native stream playing.
  assert.match(grab('function stopExclusiveForReloadedPage('), /invalidateExclusiveRequests\?\.\(\);\s*exclusiveOutput\?\.stop\(\);/);
  assert.match(main, /if \(action === 'ignore'\) return;\s*stopExclusiveForReloadedPage\(\);/);

  // A transient probe failure is not remembered.
  assert.match(main, /if \(isStorageError\(err\)\) return source;/);

  // The first window waits for bootstrap.
  assert.match(main, /mainWin = createWindow\(\);\s*mainWindowBootstrapped = true;/);
  assert.match(main, /else if \(mainWindowBootstrapped\) \{\s*mainWin = createWindow\(\);/);

  // A hidden Mac keeps playing through sleep notices.
  assert.match(main, /powerMonitor\.on\('resume'/);
  assert.match(main, /powerSaveBlocker\.start\('prevent-app-suspension'\)/);
}

console.log('PASS main.ts: slow-share tolerance, opened files, Dock and File menus, navigation, quit teardown');
