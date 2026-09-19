// Folder smart rules and path: search.
// - A folder rule returns every track under the folder, subfolders included,
//   in folder order, ignoring the rule's count and mood; other filters narrow.
// - A sibling folder that shares the name prefix ("To Listen Later") is out.
// - The rule's folder survives a save and a reopen of the library.
// - path: accepts a typed Windows path in quotes and either separator.
// Run: npm run build:electron && node scripts/folder-rules-test.mjs
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LibraryStore } from '../dist-electron/electron/library.js';

const root = resolve('tmp', 'folder-rules-test');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const dbPath = join(root, 'library.db');

const base = {
  album: 'A', albumArtist: 'X', discNo: 1, year: 2001, genre: 'Rock', duration: 200, bitrate: 320000,
  sampleRate: 44100, replayGainTrackDb: null, replayGainAlbumDb: null, size: 1, mtime: 1, art: null,
};
const posix = ['/music/To Listen/b-second.mp3', '/music/To Listen/a-first.mp3', '/music/To Listen/Sub/c-third.mp3',
  '/music/To Listen Later/nope.mp3', '/music/Other/nope.mp3'];
const windows = ['C:\\Music\\Inbox\\one.flac', 'C:\\Music\\Inbox\\Deep\\two.flac', 'C:\\Music\\Elsewhere\\three.flac'];
let lib = await LibraryStore.open(dbPath);
lib.upsertTracks([...posix, ...windows].map((path, i) => ({
  ...base, path, title: path.split(/[\\/]/).pop(), artist: `Artist ${i}`, trackNo: i + 1,
})));

const titles = (tracks) => tracks.map((t) => t.title);
const folderRule = { name: 'To Listen', mood: 'drive', count: 1, folderPath: '/music/To Listen' };
assert.deepEqual(
  titles(lib.runSmartPlaylistRule(folderRule)),
  ['a-first.mp3', 'b-second.mp3', 'c-third.mp3'],
  'whole folder, subfolders included, in path order, count and mood ignored',
);

const loved = lib.getTracks({ limit: 50, offset: 0 }).find((t) => t.title === 'b-second.mp3');
lib.toggleLove(loved.id);
assert.deepEqual(titles(lib.runSmartPlaylistRule({ ...folderRule, lovedOnly: true })), ['b-second.mp3'], 'other filters still narrow');

// Auto DJ asks for a bounded sample instead of carrying a whole folder over
// IPC. Every track under the folder stays eligible; only the count is capped.
const sampled = lib.runSmartPlaylistRule(folderRule, 2);
assert.equal(sampled.length, 2, 'a sample returns the requested count');
const seen = new Set();
for (let i = 0; i < 40; i += 1) for (const t of lib.runSmartPlaylistRule(folderRule, 2)) seen.add(t.title);
assert.deepEqual([...seen].sort(), ['a-first.mp3', 'b-second.mp3', 'c-third.mp3'], 'sampling reaches every track');
assert.equal(lib.runSmartPlaylistRule(folderRule, 99).length, 3, 'a sample larger than the folder returns it all');
assert.equal(lib.runSmartPlaylistRule(folderRule, 0).length, 3, 'no sample means the whole folder');

// SQLite's lower() folds ASCII only. A folder whose name carries a non-ASCII
// capital used to match nothing at all: the LIKE parameter had been folded in
// JS, the column had not.
lib.upsertTracks([
  '/music/Ólafur Arnalds/island.mp3',
  '/music/Édith Piaf/regrette.mp3',
  '/music/Rock/loud.mp3',
  '/music/rock/quiet.mp3',
].map((path, i) => ({
  ...base, path, title: path.split('/').pop(), artist: `Accent ${i}`, trackNo: 90 + i,
})));
assert.deepEqual(
  titles(lib.runSmartPlaylistRule({ name: 'O', mood: 'focus', count: 50, folderPath: '/music/Ólafur Arnalds' })),
  ['island.mp3'],
  'a folder with a non-ASCII capital is still a folder',
);
assert.deepEqual(
  titles(lib.getTracks({ search: 'path:"/music/Édith Piaf"', limit: 50, offset: 0 })),
  ['regrette.mp3'],
  'path: search reaches a non-ASCII capital',
);
// Case is a real distinction on Linux and not on Windows or macOS.
const caseFolds = process.platform === 'win32' || process.platform === 'darwin';
assert.deepEqual(
  titles(lib.runSmartPlaylistRule({ name: 'R', mood: 'focus', count: 50, folderPath: '/music/Rock' })).sort(),
  caseFolds ? ['loud.mp3', 'quiet.mp3'] : ['loud.mp3'],
  caseFolds ? 'Rock and rock are one folder here' : 'Rock and rock are two folders here',
);

const saved = lib.saveSmartPlaylistRule(folderRule);
assert.equal(saved.folderPath, '/music/To Listen');
await lib.close();
lib = await LibraryStore.open(dbPath);
const reopened = lib.getSmartPlaylistRules().find((rule) => rule.id === saved.id);
assert.equal(reopened.folderPath, '/music/To Listen', 'folder survives a reopen');
assert.equal(lib.runSmartPlaylistRule(saved.id).length, 3);
const plain = lib.saveSmartPlaylistRule({ name: 'Plain', mood: 'focus', count: 2 });
assert.equal(plain.folderPath, null, 'ordinary rules have no folder');

const search = (q) => titles(lib.getTracks({ search: q, limit: 50, offset: 0 })).sort();
assert.deepEqual(search('path:"C:\\Music\\Inbox"'), ['one.flac', 'two.flac'], 'typed Windows path in quotes');
assert.deepEqual(search('path:C:/Music/Inbox'), ['one.flac', 'two.flac'], 'forward slashes match backslash paths');
assert.deepEqual(search('path:"\\music\\to listen\\sub"'), ['c-third.mp3'], 'backslashes match forward-slash paths');
assert.deepEqual(search('title:"say \\"hi\\""'), [], 'an escaped quote still parses');

await lib.close();
console.log('PASS folder rules and path search');
