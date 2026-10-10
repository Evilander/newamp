// The native track menu's item list: queue actions, the Add to Playlist
// submenu (new playlist first, then every saved playlist), and Show in Folder
// only when there is a single local file to show.
import assert from 'node:assert/strict';
import { trackContextMenuTemplate } from '../dist-electron/electron/track-context-menu.js';

const chosen = [];
const choose = (choice) => () => chosen.push(choice);
const labels = (items) => items.map((item) => (item.type === 'separator' ? '---' : item.label));

const bin = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';
const one = trackContextMenuTemplate(
  { trackCount: 1, playlists: [{ id: 4, name: 'CD Mix' }, { id: 9, name: 'Rock & Roll' }], canShowInFolder: true, canTrash: true },
  choose,
);
assert.deepEqual(labels(one), ['Play Next', 'Add to Queue', '---', 'Add to Playlist', '---', 'Show in Folder', '---', `Move to ${bin}`]);
const submenu = one[3].submenu;
assert.deepEqual(labels(submenu), ['New Playlist', '---', 'CD Mix', 'Rock && Roll'], "'&' is escaped so Windows shows it");

submenu[2].click();
submenu[0].click();
one[0].click();
one[5].click();
one[7].click();
assert.deepEqual(chosen, [
  { action: 'add-to-playlist', playlistId: 4 },
  { action: 'new-playlist' },
  { action: 'play-next' },
  { action: 'show-in-folder' },
  { action: 'trash' },
]);

const many = trackContextMenuTemplate({ trackCount: 1200, playlists: [], canShowInFolder: false }, choose);
assert.deepEqual(labels(many), ['Play Next', 'Add to Queue', '---', 'Add to Playlist'], 'no trash item for streams');
const manyLocal = trackContextMenuTemplate({ trackCount: 1200, playlists: [], canShowInFolder: false, canTrash: true }, choose);
assert.equal(labels(manyLocal).at(-1), `Move 1,200 Files to ${bin}`);
assert.deepEqual(labels(many[3].submenu), ['New Playlist from 1,200 Tracks'], 'no separator without playlists');

const junk = trackContextMenuTemplate(
  { trackCount: 'x', playlists: [{ id: 0, name: 'zero' }, { id: 3, name: '' }, null, { id: 5, name: 'ok' }] },
  choose,
);
assert.deepEqual(labels(junk[3].submenu), ['New Playlist', '---', 'ok'], 'invalid playlist entries are dropped');

console.log('PASS track context menu template');
