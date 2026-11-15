// Pieces of electron/main.ts for a library on a flaky share: which opened files are
// served, the held watcher plans, the FLAC warm, and the playback-aware daily
// backup retry, plus the shape of the handlers that moved to the sliced
// library calls. main.ts cannot be loaded outside Electron, so each piece is
// cut out of the source as written, compiled, and run against stubs.
// Run: node scripts/main-handlers-test.mjs
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const main = (await readFile(resolve(root, 'electron/main.ts'), 'utf8')).replace(/\r\n/g, '\n');
const historyIpc = await readFile(resolve(root, 'electron/history-ipc.ts'), 'utf8');
const detached = await readFile(resolve(root, 'src/detached/main.tsx'), 'utf8');

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
  const names = pieces
    .map((piece) => /^(?:async )?function (\w+)\(/.exec(piece)?.[1])
    .filter(Boolean);
  vm.runInNewContext(`${code}\nthis.__exports = { ${names.join(', ')} };`, context);
  return context.__exports;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- only audio files are authorized for the protocol ------------------------------
{
  const openedAudioFiles = new Set();
  const { allowOpenedAudioFile } = await load([grab('async function allowOpenedAudioFile(')], {
    OPEN_AUDIO_EXTS: new Set(['.mp3', '.flac']),
    extname,
    resolve,
    openedAudioFiles,
    realpath: async (path) => path,
  });
  await allowOpenedAudioFile('/music/a.MP3');
  await allowOpenedAudioFile('/home/me/.ssh/id_rsa');
  await allowOpenedAudioFile('/home/me/notes.txt');
  await allowOpenedAudioFile('/music/noext');
  assert.deepEqual([...openedAudioFiles], ['/music/a.MP3'], 'a path without an audio extension is not let in, however it arrives');
}

// ---- held watcher plans are replayed when the last holder lets go ------------------
{
  const reconciled = [];
  const requested = [];
  const settings = { get: () => ({ libraryAutoWatch: true }) };
  const context = {
    settings,
    Math,
    Set,
    reconcileWatchedTargets: (targets, plan) => reconciled.push({ targets, plan }),
    incrementalScans: { request: (roots) => requested.push(roots) },
  };
  const pieces = [
    'let libraryMutationsQuiesced = 0;',
    'let heldWatchPlans: Array<{ targets: string[]; plan: unknown }> = [];',
    'let heldIncrementalRoots = new Set<string>();',
    grab('function resumeLibraryMutations('),
    'function hold(count: number, plans: Array<{ targets: string[]; plan: unknown }>, roots: string[]) { libraryMutationsQuiesced = count; heldWatchPlans = plans; heldIncrementalRoots = new Set(roots); }',
    'function held() { return { count: libraryMutationsQuiesced, plans: heldWatchPlans.length, roots: heldIncrementalRoots.size }; }',
  ];
  const { resumeLibraryMutations, hold, held } = await load(pieces, context);
  const plan = { force: ['/a/x.flac'], incremental: ['/a'] };

  hold(2, [{ targets: ['/a/x.flac'], plan }], ['/b']);
  resumeLibraryMutations();
  assert.deepEqual([reconciled.length, requested.length], [0, 0], 'one holder is still there, so nothing is replayed');
  resumeLibraryMutations();
  assert.deepEqual(JSON.parse(JSON.stringify(reconciled)), [{ targets: ['/a/x.flac'], plan }], 'the held plan is reconciled once the last holder resumes');
  assert.deepEqual(JSON.parse(JSON.stringify(requested)), [['/b']], 'the held root walk is requested');
  assert.deepEqual(JSON.parse(JSON.stringify(held())), { count: 0, plans: 0, roots: 0 }, 'nothing stays held after the replay');

  settings.get = () => ({ libraryAutoWatch: false });
  hold(1, [{ targets: ['/a/y.flac'], plan }], ['/c']);
  resumeLibraryMutations();
  assert.equal(reconciled.length, 1, 'with auto-watch off the held plans are dropped, not replayed');
  assert.deepEqual(JSON.parse(JSON.stringify(held())), { count: 0, plans: 0, roots: 0 });
}

// ---- the FLAC warm waits, and only two tracks are ever waiting ---------------------
{
  const warmed = [];
  const pieces = [
    grab('const FLAC_WARM_DELAY_MS').replace('10_000', '40'),
    grab('const FLAC_WARM_MAX_PENDING'),
    grab('const pendingFlacWarms'),
    grab('function scheduleFlacWarm('),
  ];
  const { scheduleFlacWarm } = await load(pieces, {
    Map,
    setTimeout,
    clearTimeout,
    getOrTranscodeToFlac: async (path) => { warmed.push(path); },
  });
  scheduleFlacWarm('/a.wma');
  assert.deepEqual(warmed, [], 'a miss does not start an encode at once');
  await sleep(90);
  assert.deepEqual(warmed, ['/a.wma'], 'a track that stays requested is warmed');

  // Skipping through an album: each track is requested, only the last two survive.
  warmed.length = 0;
  for (const name of ['t1', 't2', 't3', 't4', 't5']) scheduleFlacWarm(`/${name}.wma`);
  scheduleFlacWarm('/t5.wma');
  await sleep(90);
  assert.deepEqual(warmed, ['/t4.wma', '/t5.wma'], 'the playing track and the prepared next one are warmed, the skipped ones are not');
}

// ---- a daily backup put off for playback is tried again once playback stops --------
{
  const runs = [];
  const state = { isPlaying: true };
  const pieces = [
    'let dailyBackupWaitingForIdle = false;',
    'let dailyBackupIdleTimer: NodeJS.Timeout | null = null;',
    grab('const DAILY_BACKUP_IDLE_DELAY_MS').replace('30 * 1000', '30'),
    grab('function retryDeferredDailyBackup('),
    'function waitForIdle(on: boolean) { dailyBackupWaitingForIdle = on; }',
  ];
  const { retryDeferredDailyBackup, waitForIdle } = await load(pieces, {
    setTimeout: (fn, ms) => Object.assign(setTimeout(fn, ms), { unref() { return this; } }),
    shellPlaybackState: state,
    runDailyBackup: async () => { runs.push(1); },
  });
  retryDeferredDailyBackup();
  waitForIdle(true);
  retryDeferredDailyBackup();
  await sleep(80);
  assert.equal(runs.length, 0, 'while a track plays the copy keeps waiting');
  state.isPlaying = false;
  retryDeferredDailyBackup();
  retryDeferredDailyBackup();
  await sleep(80);
  assert.equal(runs.length, 1, 'a pause lets the copy run, once');
  waitForIdle(false);
  retryDeferredDailyBackup();
  await sleep(80);
  assert.equal(runs.length, 1, 'nothing is retried when no copy was put off');
}

// ---- how the handlers are wired ------------------------------------------------------
const code = main.replace(/\/\/.*$/gm, '');
const crash = /process\.on\('uncaughtException'[\s\S]*?\n\}\);/.exec(code)?.[0] ?? '';
assert.match(crash, /exclusiveOutput\?\.dispose\(\)/, 'a crash restores the device sample rate');
assert.ok(crash.indexOf('dispose()') < crash.indexOf('process.exit(1)'), 'it does so before the process exits');

const reconcile = /function reconcileWatchedTargets[\s\S]*?\n\}\n/.exec(code)?.[0] ?? '';
assert.match(reconcile, /await library\.markTracksMissingAsync\(watched\)/, 'the watcher marks only what the storage answered for');
assert.doesNotMatch(reconcile, /existsSync|markTracksMissing\(/, 'the reconcile makes no synchronous existence check');
assert.match(reconcile, /\.catch\(logWatcherScanFailure\)/, 'a forced scan that fails is logged, not unhandled');
for (const call of code.match(/void scanner\.start\([^\n]*/g) ?? []) assert.match(call, /\.catch\(/, `${call} handles its failure`);

for (const sync of ['previewPruneMissingTracks(', 'pruneMissingTracks(', 'recomputeTags(', 'previewTagRule(', 'getListeningInsights(', 'getWrappedStats(']) {
  assert.ok(!code.includes(`library.${sync}`), `no handler calls library.${sync} on the main thread`);
}
assert.match(code, /library\.previewPruneMissingTracksAsync\(/);
assert.match(code, /await library\.recomputeTagsAsync\(/);
assert.match(code, /library\.previewTagRuleAsync\(/);
assert.match(code, /library\.getListeningInsightsAsync\(/);
assert.match(code, /library\.getWrappedStatsAsync\(/);

const clear = /ipcMain\.handle\('history:clear'[\s\S]*?\n  \}\);/.exec(code)?.[0] ?? '';
assert.ok(clear.indexOf('createBackupFromLiveStores') !== -1 && clear.indexOf('createBackupFromLiveStores') < clear.indexOf('clearListeningHistory'), 'clearing the history takes a backup first');
assert.match(clear, /resumeLibraryMutations\(\)/, 'and lets the watcher go again');

assert.match(code, /defer: \(\) => shellPlaybackState\.isPlaying/, 'the daily backup waits for playback');
assert.match(code, /if \(!isPermanentLastfmRejection\(err\)\)/, 'a refusal Last.fm may still take is queued');
assert.match(historyIpc, /await library\.importListeningHistoryAsync\(/, 'the history import runs in slices');
assert.match(detached, /\['dragover', 'drop'\][\s\S]{0,120}preventDefault\(\)/, 'a file dropped on the projector is swallowed');

console.log('PASS main.ts handlers: opened-file extensions, held watcher plans, FLAC warm, backup retry, handler wiring');
