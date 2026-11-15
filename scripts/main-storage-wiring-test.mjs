// How electron/main.ts treats a slow or failing network share, opened files,
// the Dock and File menus, and the quit path. main.ts cannot be loaded outside
// Electron, so each piece is cut out of the source as written, compiled, and run
// against stubs.
// Run: node scripts/main-storage-wiring-test.mjs
import assert from 'node:assert/strict';
import { build, transform } from 'esbuild';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
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

  // The quit teardown runs once and each step stands alone.
  const quit = main.slice(main.indexOf("app.on('will-quit', (event) => {"));
  const body = quit.slice(0, quit.indexOf('\n});\n'));
  assert.match(body, /if \(!willQuitTeardownDone\) \{\s*willQuitTeardownDone = true;/);
  for (const step of ['settings?.flushSync()', 'podcastStore?.flushProgressSync()', 'exclusiveOutput?.dispose()', 'tray?.destroy()', 'killAllTranscodeFfmpeg()', 'closeAllGaplessSessions()']) {
    assert.match(body, new RegExp(`try \\{ ${step.replace(/[()?.]/g, '\\$&')};? \\} catch`), `${step} cannot stop the steps after it`);
  }

  // A hidden Mac keeps playing through sleep notices.
  assert.match(main, /powerMonitor\.on\('resume'/);
  assert.match(main, /powerSaveBlocker\.start\('prevent-app-suspension'\)/);
}

console.log('PASS main.ts: slow-share tolerance, opened files, Dock and File menus, navigation, quit teardown');
