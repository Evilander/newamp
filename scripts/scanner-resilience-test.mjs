// How the scanner and the library watcher behave on a share that is slow or
// failing, and on names a Windows-made library has:
//  - Names with several leading dots ("...And Justice For All") are music;
//    one dot still hides a file or folder. The watcher and the scanner share one
//    list of audio extensions and one set of skip rules, including @eaDir.
//  - A rename event inside a skipped folder (Logic, Ableton, a package, a
//    hidden folder) queues no scan, whatever the renamed folder is called.
//  - A root whose check times out is left alone; a root that is gone is only
//    dropped after two checks in a row; a check already running is not stacked on.
//  - Roots on NFS, SMB or FUSE volumes are found from the mount table and
//    handed to the rescan callback on a timer.
//  - A walk stats at most eight files of a folder at once, and a stat that times
//    out exempts its folder from "not found, so missing".
//  - A tag read the storage failed leaves the backfill's row queued; a file
//    refused for now (EACCES) gets no guessed row; an empty cover is no cover;
//    a folder with an @eaDir still has its album art; a failed scan still ends.
//  - A raw AAC file's duration is estimated rather than read frame by frame.
// Run: npm run build:electron && node scripts/scanner-resilience-test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { existsSync, promises as fsp, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '../dist-electron/electron/library.js';
import { Scanner, readTagExtras } from '../dist-electron/electron/scanner.js';
import { runTagBackfill } from '../dist-electron/electron/album-identity-backfill.js';
import { AUDIO_EXTS, isHiddenName, isSkippedLibraryFile, isSkippedLibraryFolder, isSkippedLibraryPath } from '../dist-electron/electron/library-skip.js';
import { isFolderArtImage } from '../dist-electron/electron/folder-art.js';
import {
  LibraryWatcher,
  isOnRemoteMount,
  isOnRemoteVolume,
  isWindowsNetworkPath,
  parseMountTable,
  parseNetUse,
  resolveLibraryWatchTarget,
  resolvedWithin,
} from '../dist-electron/electron/library-watcher.js';
import { albumRootOf } from '../dist-electron/shared/album-identity.js';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = join(repoRoot, 'tmp', 'scanner-resilience-test');
await rm(root, { recursive: true, force: true });
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
async function waitFor(condition, what, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    assert.ok(performance.now() < deadline, `timed out waiting for ${what}`);
    await sleep(10);
  }
}

// 1. Names. A single leading dot hides; several do not.
assert.equal(isHiddenName('.DS_Store'), true);
assert.equal(isHiddenName('._01 Intro.mp3'), true);
assert.equal(isHiddenName('...And Justice For All'), false);
assert.equal(isSkippedLibraryFolder('...Like Clockwork'), false);
assert.equal(isSkippedLibraryFile('...Baby One More Time.flac'), false);
assert.equal(isSkippedLibraryFolder('.thumbnails'), true);
assert.equal(isSkippedLibraryFile('.hidden.flac'), true);
assert.equal(isSkippedLibraryFolder('@eaDir', 'Album'), true, 'a Synology index folder is skipped');
assert.equal(isSkippedLibraryPath('Metallica/...And Justice For All/01 Blackened.flac'), false);
assert.equal(isSkippedLibraryPath('Artist/Album/@eaDir/01.mp3/SYNOAUDIO.flac'), true);
assert.equal(isFolderArtImage('...cover.jpg'), true);
assert.equal(isFolderArtImage('.cover.jpg'), false);
assert.equal(resolveLibraryWatchTarget('/m', '...And Justice For All/01.flac'), join(resolve('/m'), '...And Justice For All', '01.flac'));

// One list of audio extensions, kept by both consumers.
for (const file of ['scanner.ts', 'library-watcher.ts']) {
  const source = await readFile(join(repoRoot, 'electron', file), 'utf8');
  assert.doesNotMatch(source, /const AUDIO_EXTS\b/, `${file} takes the audio extensions from library-skip.ts`);
  assert.match(source, /AUDIO_EXTS[^;]*from '\.\/library-skip\.js'/, `${file} imports them`);
}
assert.equal(AUDIO_EXTS.size, 23);
for (const ext of ['.mp3', '.flac', '.m4a', '.dsf', '.dts']) assert.ok(AUDIO_EXTS.has(ext), `${ext} is an audio file`);

// "Vol" and "Side" only make a disc folder when nothing follows them.
assert.deepEqual(albumRootOf('music/artist/album/vol. 3 - remixes'), { root: 'music/artist/album/vol. 3 - remixes', disc: null });
assert.deepEqual(albumRootOf('music/artist/album/side a songs'), { root: 'music/artist/album/side a songs', disc: null });
assert.deepEqual(albumRootOf('music/artist/album/side a'), { root: 'music/artist/album', disc: null });
assert.deepEqual(albumRootOf('music/artist/album/vol. 2'), { root: 'music/artist/album', disc: null });
assert.deepEqual(albumRootOf('music/artist/album/cd 2 - live'), { root: 'music/artist/album', disc: 2 });
assert.deepEqual(albumRootOf('music/artist/album/disc 02'), { root: 'music/artist/album', disc: 2 });

// 2. A rename inside a skipped folder queues nothing.
{
  const watchRoot = join(root, 'watch');
  for (const dir of [
    'Audio Music Apps/Sampler Instruments/Piano',
    'Song.logicx/Media',
    '.hidden/inner',
    'Ableton/Factory Packs/Core',
    'Artist/New Album',
    'Artist/...And Justice For All',
  ]) await mkdir(join(watchRoot, ...dir.split('/')), { recursive: true });
  const batches = [];
  const watcher = new LibraryWatcher((targets, plan) => void batches.push({ targets, plan }), { debounceMs: 50, remotePollMs: 0 });
  const emit = (eventType, fileName) => watcher.onWatchEvent(watchRoot, true, watcher.generation, eventType, fileName);
  for (const name of [
    'Audio Music Apps/Sampler Instruments/Piano',
    'Audio Music Apps',
    'Song.logicx',
    'Song.logicx/Media',
    '.hidden/inner',
    'Ableton/Factory Packs/Core',
    'Audio Music Apps/Removed Instrument',
  ]) emit('rename', name);
  await sleep(100);
  watcher.flushNow();
  assert.deepEqual(batches, [], 'no scan is queued for a folder made or removed inside a skipped one');

  emit('rename', 'Artist/New Album');
  emit('rename', 'Artist/...And Justice For All');
  await waitFor(() => watcher.pendingRenames.size === 0, 'rename events to settle');
  watcher.flushNow();
  assert.deepEqual(
    batches[0].plan.incremental.sort(),
    [join(watchRoot, 'Artist', '...And Justice For All'), join(watchRoot, 'Artist', 'New Album')].sort(),
    'a new album folder is scanned, a "..." one too',
  );
  watcher.stop();
}

// 3. Root checks.
{
  const rootDir = join(root, 'roots', 'library');
  await mkdir(rootDir, { recursive: true });
  const changed = [];
  const returned = [];
  const watcher = new LibraryWatcher((targets) => void changed.push(...targets), {
    debounceMs: 50,
    rootPollMs: 600_000,
    remotePollMs: 0,
    onRootAvailable: (path) => returned.push(path),
  });
  watcher.start([rootDir]);
  const check = () => watcher.checkRoots(watcher.generation);

  watcher.probeRoot = async () => 'unknown';
  for (let i = 0; i < 4; i += 1) await check();
  watcher.flushNow();
  assert.deepEqual(watcher.getWatchedRoots(), [rootDir], 'a root that timed out is still watched');
  assert.deepEqual(changed, [], 'and nothing is queued for it');

  watcher.probeRoot = async () => 'gone';
  await check();
  assert.deepEqual(watcher.getWatchedRoots(), [rootDir], 'one check that finds it gone is not enough');
  watcher.probeRoot = async () => 'present';
  await check();
  watcher.probeRoot = async () => 'gone';
  await check();
  assert.deepEqual(watcher.getWatchedRoots(), [rootDir], 'a root that answered in between starts counting again');
  await check();
  assert.deepEqual(watcher.getWatchedRoots(), [], 'two in a row drop it');
  watcher.flushNow();
  assert.deepEqual(changed, [rootDir], 'and queue it');

  delete watcher.probeRoot;
  await check();
  assert.deepEqual(watcher.getWatchedRoots(), [rootDir], 'a root that answers is watched again');
  assert.deepEqual(returned, [rootDir], 'and handed over for a rescan');

  assert.equal(await watcher.probeRoot(rootDir), 'present');
  assert.equal(await watcher.probeRoot(join(rootDir, 'nope')), 'gone');
  await writeFile(join(rootDir, 'file.txt'), 'x');
  assert.equal(await watcher.probeRoot(join(rootDir, 'file.txt')), 'gone', 'a file is not a root');
  assert.equal(await watcher.probeRoot(join(rootDir, 'file.txt', 'inside')), 'gone');

  // A check that is still waiting is not stacked on.
  let probes = 0;
  let release;
  const held = new Promise((resolveHeld) => { release = resolveHeld; });
  watcher.probeRoot = async () => { probes += 1; await held; return 'present'; };
  const first = check();
  await check();
  assert.equal(probes, 1, 'the second check returned at once');
  release();
  await first;
  await check();
  assert.equal(probes, 2, 'and the next one runs');
  watcher.stop();
}

// 4. Network volumes.
{
  const macMounts = parseMountTable([
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
    'localhost:/ on /Users/tyler/pc/k (nfs, nodev, nosuid, mounted by tyler)',
    '//tyler@nas/Music Share on /Volumes/Music Share (smbfs, nodev, nosuid, mounted by tyler)',
    'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
  ].join('\n'), 'mount');
  assert.deepEqual(macMounts.map((m) => m.type), ['apfs', 'apfs', 'nfs', 'smbfs', 'autofs']);
  assert.equal(macMounts[3].mountPoint, '/Volumes/Music Share');
  const linuxMounts = parseMountTable([
    '/dev/sda1 / ext4 rw,relatime 0 0',
    'server:/export /mnt/my\\040music nfs4 rw,soft 0 0',
    'rclone: /mnt/cloud fuse.rclone rw 0 0',
    '/dev/sdb1 /mnt/usb fuseblk rw 0 0',
  ].join('\n'), 'proc');
  assert.equal(linuxMounts[1].mountPoint, '/mnt/my music');
  assert.equal(isOnRemoteMount('/Users/tyler/pc/k/music', macMounts), true, 'an NFS mount');
  // Mount points are matched without regard to case where the file system
  // ignores it, which Linux does not.
  assert.equal(isOnRemoteMount('/users/tyler/pc/k/music', macMounts), process.platform !== 'linux', 'case is ignored except on Linux');
  assert.equal(isOnRemoteMount('/Volumes/Music Share/Albums', macMounts), true, 'an SMB mount');
  assert.equal(isOnRemoteMount('/users/tyler/music', macMounts), false, 'the boot volume');
  assert.equal(isOnRemoteMount('/mnt/my music/albums', linuxMounts), true);
  assert.equal(isOnRemoteMount('/mnt/cloud', linuxMounts), true, 'a FUSE mount');
  assert.equal(isOnRemoteMount('/mnt/other', linuxMounts), false);
  assert.equal(isOnRemoteMount('/mnt/usb/music', linuxMounts), false, 'a local disk behind fuseblk');

  const rootDir = join(root, 'remote', 'library');
  await mkdir(rootDir, { recursive: true });
  const rescans = [];
  const watcher = new LibraryWatcher(() => {}, { rootPollMs: 600_000, remotePollMs: 0, onRootAvailable: (path) => rescans.push(path) });
  watcher.start([rootDir]);
  assert.deepEqual(watcher.getPollingRoots(), [], 'a local root is not polled');
  watcher.remoteRoots = [rootDir];
  assert.deepEqual(watcher.getPollingRoots(), [rootDir]);
  await watcher.pollRemoteRoots(watcher.generation);
  assert.deepEqual(rescans, [rootDir], 'a polled root is handed over for a rescan');
  watcher.stop();
}

// 4b. Network volumes on Windows, and what "gone" means for a root on one.
{
  assert.equal(isWindowsNetworkPath('\\\\nas\\music\\Albums'), true, 'a UNC name');
  assert.equal(isWindowsNetworkPath('\\\\?\\UNC\\nas\\music'), true, 'the form a mapped drive resolves to');
  assert.equal(isWindowsNetworkPath('\\\\?\\C:\\Music'), false, 'a long path on a local drive');
  assert.equal(isWindowsNetworkPath('\\\\.\\PhysicalDrive0'), false);
  assert.equal(isWindowsNetworkPath('C:\\Music'), false);
  assert.equal(isWindowsNetworkPath('/Volumes/Music'), false);

  const listing = [
    'New connections will be remembered.',
    '',
    'Status       Local     Remote                    Network',
    '-------------------------------------------------------------------------------',
    'OK           Y:        \\\\nas\\Music Share           Microsoft Windows Network',
    'Unavailable  Z:        \\\\192.168.1.3\\Share         Microsoft Windows Network',
    '                       \\\\nas\\IPC$                  Microsoft Windows Network',
    'The command completed successfully.',
  ].join('\r\n');
  assert.deepEqual(parseNetUse(listing).map((mount) => mount.mountPoint), ['y:', 'z:'], 'the mapped letters, share up or not');
  assert.deepEqual(parseNetUse('Nicht verfügbar  Q:  \\\\server\\freigabe  Microsoft Windows-Netzwerk').map((mount) => mount.mountPoint), ['q:'], 'whatever the language of the headings');
  assert.deepEqual(parseNetUse('There are no entries in the list.'), []);
  if (process.platform === 'win32') {
    const mapped = parseNetUse(listing);
    assert.equal(isOnRemoteVolume('Z:\\Music', mapped), true, 'a mapped drive, even with its share down');
    assert.equal(isOnRemoteVolume('y:\\music', mapped), true, 'whatever the case');
    assert.equal(isOnRemoteVolume('C:\\Music', mapped), false);
    assert.equal(isOnRemoteVolume('\\\\nas\\music', []), true, 'a UNC name needs no listing');
  }

  // A root on a network volume is gone only when the folder holding it answers.
  const volume = join(root, 'volume');
  await mkdir(join(volume, 'mounted'), { recursive: true });
  const probing = new LibraryWatcher(() => {}, { rootPollMs: 600_000, remotePollMs: 0 });
  const deleted = join(volume, 'mounted', 'music');
  const unreachable = join(volume, 'unmounted', 'music');
  assert.equal(await probing.probeRoot(deleted), 'gone');
  assert.equal(await probing.probeRoot(unreachable), 'gone', 'a local root that is not there is gone');
  probing.remoteRoots = [deleted, unreachable];
  assert.equal(await probing.probeRoot(deleted), 'gone', 'on a network volume it is gone when the folder holding it answers');
  assert.equal(await probing.probeRoot(unreachable), 'unknown', 'and not when that answers nothing either');
  if (process.platform === 'win32') {
    // A mapped drive whose share is down answers "no such folder" for every path on it.
    const letter = [...'ZYXWVUTSRQPONMLKJIHGFEDCBA'].find((candidate) => !existsSync(`${candidate}:\\`));
    const drive = `${letter}:\\`;
    probing.remoteRoots = [];
    assert.equal(await probing.probeRoot(drive), 'gone');
    probing.remoteRoots = [drive];
    assert.equal(await probing.probeRoot(drive), 'unknown', 'a drive root has no folder above it to ask');
  }

  const kept = join(volume, 'kept');
  await mkdir(kept, { recursive: true });
  const changed = [];
  const returned = [];
  const watcher = new LibraryWatcher((targets) => void changed.push(...targets), {
    debounceMs: 50,
    rootPollMs: 600_000,
    remotePollMs: 0,
    onRootAvailable: (path) => returned.push(path),
  });
  watcher.start([kept]);
  watcher.remoteRoots = [kept];
  const check = () => watcher.checkRoots(watcher.generation);
  watcher.statFolder = async (path) => (path === kept ? 'gone' : 'unknown');
  for (let i = 0; i < 4; i += 1) await check();
  watcher.flushNow();
  assert.deepEqual(watcher.getWatchedRoots(), [kept], 'a share that answers nothing is still watched');
  assert.deepEqual(changed, [], 'and its tracks are not queued to be marked missing');
  watcher.statFolder = async (path) => (path === kept ? 'gone' : 'present');
  await check();
  await check();
  watcher.flushNow();
  assert.deepEqual(changed, [kept], 'a folder removed from a share that is up is queued as before');
  watcher.stop();

  // A share mounted over the folder, or a drive swapped under it, is a new volume.
  const mounting = new LibraryWatcher(() => {}, { rootPollMs: 600_000, remotePollMs: 0, onRootAvailable: (path) => returned.push(path) });
  returned.length = 0;
  mounting.start([kept]);
  let device = 11;
  mounting.probeRoot = async (path) => {
    mounting.probedDevices.set(path, device);
    return 'present';
  };
  const mountCheck = () => mounting.checkRoots(mounting.generation);
  await mountCheck();
  await mountCheck();
  assert.deepEqual(returned, [], 'the same volume asks for nothing');
  device = 12;
  await mountCheck();
  assert.deepEqual(returned, [kept], 'a different one is handed over for a rescan');
  assert.equal(mounting.isWatching(), true, 'and watched again');
  await mountCheck();
  assert.deepEqual(returned, [kept], 'once');
  mounting.stop();

  // A root that came back after the others is last in the watched list, which is not a change of roots.
  const first = join(root, 'order', 'a');
  const second = join(root, 'order', 'b');
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  const queued = [];
  const ordered = new LibraryWatcher((targets) => void queued.push(...targets), { debounceMs: 50, rootPollMs: 600_000, remotePollMs: 0 });
  ordered.start([first, second]);
  ordered.roots = [second, first];
  const generation = ordered.generation;
  ordered.queueTarget(join(first, 'new.mp3'), 'force');
  ordered.start([first, second]);
  assert.equal(ordered.generation, generation, 'a settings save with the same roots rebuilds nothing');
  ordered.flushNow();
  assert.deepEqual(queued, [join(first, 'new.mp3')], 'and the change that was waiting is still delivered');
  ordered.stop();

  // realpath of a root on a hung mount gives the root back after a limit, so one root cannot hold up the rest.
  const realRealpath = fsp.realpath;
  fsp.realpath = (path, ...rest) => (String(path).endsWith('hung') ? new Promise(() => {}) : realRealpath(path, ...rest));
  syncBuiltinESMExports();
  // The limit's timer does not keep the process alive, so something here has to.
  const keepAlive = setInterval(() => {}, 20);
  try {
    const began = performance.now();
    assert.equal(await resolvedWithin(join(root, 'hung'), 50), join(root, 'hung'));
    assert.ok(performance.now() - began < 2000, 'it did not wait for the mount');
    assert.equal(await resolvedWithin(first, 50), await realRealpath(first), 'a root that answers is resolved');
  } finally {
    clearInterval(keepAlive);
    fsp.realpath = realRealpath;
    syncBuiltinESMExports();
  }

  if (process.platform === 'win32') {
    // Starting the watcher never asks a share for anything with a call that blocks the main thread.
    const share = '\\\\newamp-test-host.invalid\\music';
    const touched = [];
    const realExists = fs.existsSync;
    const realStatSync = fs.statSync;
    fs.existsSync = (path, ...rest) => (touched.push(String(path)), realExists(path, ...rest));
    fs.statSync = (path, ...rest) => (touched.push(String(path)), realStatSync(path, ...rest));
    syncBuiltinESMExports();
    const sharing = new LibraryWatcher(() => {}, { rootPollMs: 600_000, remotePollMs: 60_000 });
    try {
      sharing.start([share]);
    } finally {
      fs.existsSync = realExists;
      fs.statSync = realStatSync;
      syncBuiltinESMExports();
    }
    assert.ok(!touched.some((path) => path.toLowerCase().includes('newamp-test-host')), 'a share is not stat-ed with a blocking call');
    assert.deepEqual(sharing.getWatchedRoots(), []);
    await sharing.detectRemoteRoots(sharing.generation);
    assert.deepEqual(sharing.remoteRoots, [resolve(share)], 'a UNC root is recognised as a network volume without a mount table');
    sharing.stop();
  }
}

// 5. The scanner on a failing share. Reads and stats are made to fail for named
// files by patching the module the scanner and the tag parser call through.
const failing = { open: new Map(), stat: new Map() };
const codeFor = (kind, path) => {
  for (const [suffix, code] of failing[kind]) if (String(path).endsWith(suffix)) return code;
  return null;
};
const fail = (code) => Object.assign(new Error(`simulated ${code}`), { code });
const realOpen = fsp.open;
const realStat = fsp.stat;
let inFlight = 0;
let widest = 0;
let onOpen = null;
fsp.open = async (path, ...rest) => {
  onOpen?.(path);
  const code = codeFor('open', path);
  if (code) throw fail(code);
  return realOpen(path, ...rest);
};
fsp.stat = async (path, ...rest) => {
  const code = codeFor('stat', path);
  if (code) throw fail(code);
  if (/[\\/]wide[\\/]/.test(String(path)) && String(path).endsWith('.mp3')) {
    inFlight += 1;
    widest = Math.max(widest, inFlight);
    try {
      await sleep(5);
      return await realStat(path, ...rest);
    } finally {
      inFlight -= 1;
    }
  }
  return realStat(path, ...rest);
};
syncBuiltinESMExports();

const music = join(root, 'music');
const put = async (rel, content = 'not audio') => {
  const full = join(music, ...rel.split('/'));
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
  return full;
};
const library = await LibraryStore.open(join(root, 'library.db'));
const events = [];
const scanner = new Scanner(library, (event) => events.push(event));
const rows = () => library.db.exec('SELECT path, has_art, missing_since, duration, scan_schema FROM tracks')[0]?.values ?? [];
const rowOf = (path) => rows().find(([p]) => p === path);

// 5a. Names that start with several dots are scanned.
const justice = await put('Metallica/...And Justice For All/01 Blackened.mp3');
const dotted = await put('Metallica/...And Justice For All/...Intro.mp3');
const hidden = await put('Metallica/...And Justice For All/.hidden.mp3');
await scanner.start([music]);
assert.ok(rowOf(justice) && rowOf(dotted), 'a track in a "..." folder and a "..." track are indexed');
assert.equal(rowOf(hidden), undefined, 'a one-dot file is not');

// 5b. A stat that timed out is not a file that went.
const steady = await put('Share/steady.mp3');
const flaky = await put('Share/flaky.mp3');
await scanner.start([music]);
assert.ok(rowOf(flaky), 'both were indexed');
failing.stat.set('flaky.mp3', 'ETIMEDOUT');
const realMark = library.markUnfoundTracksMissingAsync.bind(library);
const marks = [];
library.markUnfoundTracksMissingAsync = (walkedRoots, found, unreadableFolders) => {
  marks.push({ found, unreadableFolders });
  return realMark(walkedRoots, found, unreadableFolders);
};
await scanner.start([music]);
delete library.markUnfoundTracksMissingAsync;
assert.ok(!marks.at(-1).found.includes(flaky), 'the walk did not find the file whose stat timed out');
assert.ok(marks.at(-1).unreadableFolders.includes(join(music, 'Share')), 'its folder is reported unreadable, so nothing in it is taken as gone');
assert.equal(rowOf(flaky)[2], null, 'and the file is not marked missing');
failing.stat.clear();

// 5c. Stats of one folder are bounded.
for (let i = 0; i < 60; i += 1) await put(`wide/${String(i).padStart(2, '0')}.mp3`);
await scanner.start([music]);
assert.ok(widest > 1 && widest <= 8, `a folder's files were stat'ed at most 8 at a time (saw ${widest})`);

// 5d. A file the process may not read yet gets no guessed row, and a row of its own once it can.
const locked = await put('Locked/locked.mp3');
failing.open.set('locked.mp3', 'EACCES');
await scanner.start([music]);
assert.equal(rowOf(locked), undefined, 'EACCES leaves the file for the next scan');
failing.open.clear();
await scanner.start([music]);
assert.ok(rowOf(locked), 'and the next scan reads it');

// 5e. An empty cover is not a cover, and costs no re-read on every scan.
await put('Empty Cover/01.mp3');
await put('Empty Cover/folder.jpg', '');
await scanner.start([music]);
const parsedBefore = events.at(-1).parsed;
await scanner.start([music]);
assert.equal(events.at(-1).parsed, 0, `an empty folder.jpg does not make every scan read the album again (first scan parsed ${parsedBefore})`);

// 5f. @eaDir beside the tracks does not stop the folder having cover art.
const eaAlbum = await put('Synology/Album/01.mp3');
await put('Synology/Album/@eaDir/01.mp3@SynoEAStream', 'x');
await put('Synology/Album/Artwork.jpg', 'cover bytes');
await scanner.start([music]);
assert.equal(rowOf(eaAlbum)[1], 1, 'the album keeps the cover its folder holds');

// 5g. Covers are not all held until the scan ends: a library of albums still gets each one's art.
for (let a = 0; a < 40; a += 1) {
  await put(`Many/Album ${a}/01.mp3`);
  await put(`Many/Album ${a}/02.mp3`);
  await put(`Many/Album ${a}/cover.jpg`, `cover ${a}`);
}
await scanner.start([music]);
const withArt = rows().filter(([p]) => p.includes(`${join(music, 'Many')}`) && p.endsWith('.mp3') && rowOf(p)[1] === 1).length;
assert.equal(withArt, 80, 'every track of every album has its cover');

// 5h. A raw AAC stream is not read to its end for a duration, and no length is guessed for it.
{
  const aac = join(music, 'Raw', 'tone.aac');
  await mkdir(join(aac, '..'), { recursive: true });
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'aac', '-b:a', '96k', '-f', 'adts', '-y', aac]);
  await scanner.start([music]);
  const duration = rowOf(aac)[3];
  assert.equal(duration, null, 'the duration of a raw AAC stream is left unset, not estimated from a first-frame bitrate');
}

// 5i. A scan that dies still ends, and the next one runs.
{
  await put('Doomed/01.mp3');
  const before = events.length;
  const realUpsert = library.upsertTracks;
  library.upsertTracks = () => { throw new Error('disk full'); };
  await assert.rejects(scanner.start([music]), /disk full/);
  delete library.upsertTracks;
  assert.equal(library.upsertTracks, realUpsert);
  const last = events.at(-1);
  assert.ok(events.length > before && last.done && last.cancelled, 'the banner is told the scan ended');
  await scanner.start([music]);
  assert.ok(events.at(-1).done && !events.at(-1).cancelled, 'and a later scan completes');
}

// 5j. A tag read the storage failed leaves the backfill's row queued.
{
  const tagged = await put('Backfill/tagged.mp3');
  await scanner.start([music]);
  const info = statSync(tagged);
  library.db.run(`UPDATE tracks SET scan_schema = 0 WHERE path = ?`, [tagged]);
  assert.equal(rowOf(tagged)[4], 0);
  failing.open.set('tagged.mp3', 'ETIMEDOUT');
  await assert.rejects(readTagExtras(tagged), (err) => err.code === 'ETIMEDOUT', 'a timed-out read is thrown, not "no tags"');
  failing.open.set('tagged.mp3', 'EACCES');
  await assert.rejects(readTagExtras(tagged), (err) => err.code === 'EACCES');
  assert.equal(await readTagExtras(join(root, 'missing.flac')), null, 'a file that is gone has no tags');
  failing.open.set('tagged.mp3', 'ETIMEDOUT');
  const failed = await runTagBackfill(library, readTagExtras, { cancelled: false });
  assert.ok(failed.skipped >= 1, `the row was skipped (${JSON.stringify(failed)})`);
  assert.equal(rowOf(tagged)[4], 0, 'and stays queued');
  failing.open.clear();
  const retried = await runTagBackfill(library, readTagExtras, { cancelled: false });
  assert.ok(retried.read + retried.unreadable >= 1);
  assert.ok(rowOf(tagged)[4] >= 1, 'the next run settles it');
  assert.equal(info.size, statSync(tagged).size);
}

// 5k. A root that is an empty folder, which is what a share that is not mounted
// leaves behind, says nothing about what is gone from it. A root with contents does.
{
  const share = join(root, 'mountpoint');
  const track = join(share, 'Album', '01.mp3');
  await mkdir(join(share, 'Album'), { recursive: true });
  await writeFile(track, 'not audio');
  await scanner.start([share]);
  assert.equal(rowOf(track)[2], null, 'indexed and present');
  await rm(join(share, 'Album'), { recursive: true });
  await scanner.start([share]);
  assert.equal(rowOf(track)[2], null, 'an empty root marks nothing missing');
  assert.equal(events.at(-1).unreachable, undefined, 'and it is not an error to report');
  await mkdir(join(share, 'Album'), { recursive: true });
  await writeFile(join(share, 'Album', '02.mp3'), 'not audio');
  await scanner.start([share]);
  assert.notEqual(rowOf(track)[2], null, 'once the root holds something, a file that is not in it is marked');
}

// 5l. A root the scan could not reach is said to be so; a folder deleted from a
// volume that answers, and an ordinary scan, are not.
{
  const absent = join(root, 'no-such-volume', 'music');
  await scanner.start([absent]);
  assert.deepEqual(events.at(-1).unreachable, [absent], 'the scan names the root it could not look in');
  assert.ok(events.at(-1).done, 'and still ends');
  await scanner.start([join(music, 'Deleted Album')]);
  assert.equal(events.at(-1).unreachable, undefined, 'a folder removed from a volume that answers is just gone');
  await scanner.start([music]);
  assert.equal(events.at(-1).unreachable, undefined);
}

// 5m. Cancelling stops the reads of the batch in progress, not only the next batch.
{
  for (let i = 0; i < 40; i += 1) await put(`Cancel/${String(i).padStart(2, '0')}.mp3`);
  const opened = [];
  onOpen = (path) => {
    if (!String(path).includes('Cancel')) return;
    opened.push(path);
    if (opened.length === 1) scanner.cancel();
  };
  await scanner.start([music]);
  onOpen = null;
  assert.ok(opened.length >= 1 && opened.length <= 8, `the reads stopped with the cancel (${opened.length} of 40 files opened)`);
  assert.ok(events.at(-1).cancelled, 'and the scan ended as cancelled');
}

// 5n. A cancel that comes while missing files are being marked ends the scan as
// cancelled, and nothing more is read.
{
  const late = await put('Late/new.mp3');
  const realMarkAsync = library.markUnfoundTracksMissingAsync.bind(library);
  library.markUnfoundTracksMissingAsync = async (...args) => {
    scanner.cancel();
    await sleep(20);
    return realMarkAsync(...args);
  };
  await scanner.start([music]);
  delete library.markUnfoundTracksMissingAsync;
  assert.ok(events.at(-1).done && events.at(-1).cancelled, 'the scan ended as cancelled');
  assert.equal(rowOf(late), undefined, 'and the new file was not read');
  await scanner.start([music]);
  assert.ok(rowOf(late), 'the next scan reads it');
}

fsp.open = realOpen;
fsp.stat = realStat;
syncBuiltinESMExports();
library.close();
await rm(root, { recursive: true, force: true });
console.log('[scanner-resilience-test] ok');
