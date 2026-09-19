// Playlists in the real app, driven over the DevTools protocol:
// - NEW PLAYLIST creates a playlist under the typed name, right away;
// - a playlist made from a Library selection shows up in the row pickers
//   without leaving the view;
// - tracks added through a picker land in the playlist;
// - removing a track from an open playlist is saved without another click;
// - a folder saved as a smart playlist plays the whole folder, and Show in
//   Library filters the Library to it.
// Run: npm run smoke:ui-playlists
import electronPath from 'electron';
import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const appRoot = resolve('.');
const smokeRoot = resolve('tmp', 'ui-playlists-smoke');
const userData = join(smokeRoot, 'user-data');
const mediaDir = join(smokeRoot, 'media');
const port = 9400 + Math.floor(Math.random() * 400);

await rm(smokeRoot, { recursive: true, force: true });
await mkdir(mediaDir, { recursive: true });
await mkdir(userData, { recursive: true });
for (const [file, title, artist] of [
  ['alpha.mp3', 'Alpha Song', 'Artist A'],
  ['beta.mp3', 'Beta Song', 'Artist B'],
  ['gamma.mp3', 'Gamma Song', 'Artist C'],
]) {
  const out = join(mediaDir, file);
  const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8',
    '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, '-metadata', `album=${artist} LP`, '-c:a', 'libmp3lame', '-q:a', '7', out],
  { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !existsSync(out)) throw new Error(`fixture failed: ${r.stderr}`);
}
await writeFile(join(userData, 'settings.json'), JSON.stringify({ libraryRoots: [mediaDir], libraryAutoWatch: false, volume: 0 }), 'utf8');

const child = spawn(String(electronPath), ['.', `--remote-debugging-port=${port}`], {
  cwd: appRoot,
  env: { ...process.env, NODE_ENV: 'production', NEWAMP_USER_DATA_DIR: userData, NEWAMP_SESSION_DATA_DIR: join(smokeRoot, 'session') },
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
const killTimer = setTimeout(() => fail('timed out'), 90_000);

function fail(message) {
  console.error(`[ui-playlists-smoke] FAIL: ${message}\n${stderr.split(/\r?\n/).slice(-20).join('\n')}`);
  child.kill();
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let seq = 0;
const pending = new Map();
for (let i = 0; i < 120 && !ws; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      };
    }
  } catch { /* not up yet */ }
  if (!ws) await sleep(500);
}
if (!ws) fail('no DevTools page');

const helpers = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (label, fn, timeout = 15000) => {
    const start = performance.now();
    while (performance.now() - start < timeout) { const v = fn(); if (v) return v; await sleep(50); }
    throw new Error('Timed out waiting for ' + label);
  };
  const buttons = () => Array.from(document.querySelectorAll('button'));
  const button = (text) => waitFor('button ' + text, () => buttons().find((b) => (b.textContent || '').trim() === text && !b.disabled));
  const nav = async (label) => { (await waitFor('nav ' + label, () => buttons().find((b) => (b.textContent || '').trim() === label))).click(); await sleep(300); };
  const type = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const pick = (select, value) => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, String(value));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const row = (title) => document.querySelector('[data-newamp-track-row][data-track-title="' + title + '"]');
  const savedPlaylistNames = () => Array.from(document.querySelectorAll('aside button span.block.truncate')).map((s) => s.textContent.trim());
`;
async function run(body) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async () => { ${helpers}\n${body} })()`, awaitPromise: true, returnByValue: true } }));
  const res = await new Promise((r) => pending.set(id, r));
  if (res.result?.exceptionDetails) fail(res.result.exceptionDetails.exception?.description ?? JSON.stringify(res.result.exceptionDetails));
  return res.result?.result?.value;
}

const result = {};
// Library scanned, first-run card out of the way.
await run(`
  await waitFor('transport', () => document.querySelector('[data-newamp-transport]'), 30000);
  const start = buttons().find((b) => /START LISTENING/i.test(b.textContent || ''));
  if (start) start.click();
  await nav('Library');
  await waitFor('three library rows', () => document.querySelectorAll('[data-newamp-track-row]').length === 3, 30000);
`);

// 1. NEW PLAYLIST creates "CD Mix" immediately.
result.created = await run(`
  await nav('Playlists');
  const name = await waitFor('name field', () => document.querySelector('input[aria-label="Playlist name"]'));
  if (name.value !== '') throw new Error('name field should start empty, got ' + JSON.stringify(name.value));
  type(name, 'CD Mix');
  (await button('NEW PLAYLIST')).click();
  await waitFor('CD Mix listed', () => savedPlaylistNames().includes('CD Mix'));
  return { listed: savedPlaylistNames(), field: name.value, emptyNote: /CD Mix is empty/.test(document.body.textContent || '') };
`);

// 2. Saving a Library selection as "Second" updates the row pickers in place.
result.livePicker = await run(`
  await nav('Library');
  await waitFor('rows', () => row('Beta Song'));
  row('Beta Song').querySelector('input[type="checkbox"]').click();
  const nameField = await waitFor('selection name', () => document.querySelector('input[aria-label="New playlist name"]'));
  type(nameField, 'Second');
  (await button('SAVE SELECTED AS PLAYLIST')).click();
  const rowPicker = () => row('Alpha Song').querySelector('select[aria-label="Add to playlist"]');
  await waitFor('row picker lists Second', () => rowPicker() && Array.from(rowPicker().options).some((o) => o.textContent === 'Second'));
  return Array.from(rowPicker().options).map((o) => o.textContent);
`);

// 3. Add Alpha and Gamma to CD Mix through the row pickers.
result.added = await run(`
  const idOf = (sel, label) => Array.from(sel.options).find((o) => o.textContent === label).value;
  for (const title of ['Alpha Song', 'Gamma Song']) {
    const sel = row(title).querySelector('select[aria-label="Add to playlist"]');
    pick(sel, idOf(sel, 'CD Mix'));
    await sleep(250);
  }
  const lists = await window.newamp.getPlaylists();
  return lists.map((p) => p.name + ':' + p.trackCount).sort();
`);

// 4. Open CD Mix, remove Alpha, leave, come back: the removal stuck.
result.afterRemove = await run(`
  await nav('Playlists');
  const entry = await waitFor('CD Mix entry', () => Array.from(document.querySelectorAll('aside button')).find((b) => (b.textContent || '').includes('CD Mix')));
  entry.click();
  const rowsOf = () => Array.from(document.querySelectorAll('ol li')).map((li) => li.textContent || '').filter((t) => /Song/.test(t));
  await waitFor('two playlist rows', () => rowsOf().length === 2);
  const alpha = Array.from(document.querySelectorAll('ol li')).find((li) => /Alpha Song/.test(li.textContent || ''));
  alpha.querySelector('button[title="Remove from playlist"]').click();
  await waitFor('one playlist row', () => rowsOf().length === 1);
  await sleep(300);
  await nav('Library');
  await nav('Playlists');
  const again = await waitFor('CD Mix entry', () => Array.from(document.querySelectorAll('aside button')).find((b) => (b.textContent || '').includes('CD Mix')));
  again.click();
  await waitFor('reloaded rows', () => rowsOf().length >= 1);
  const tracks = await window.newamp.getPlaylistTracks((await window.newamp.getPlaylists()).find((p) => p.name === 'CD Mix').id);
  return { rows: rowsOf().map((t) => (/(Alpha|Beta|Gamma) Song/.exec(t) || [])[0]), stored: tracks.map((t) => t.title) };
`);

// 5. Folders: save the media folder as a smart playlist, then filter the Library to it.
result.folder = await run(`
  await nav('Folders');
  const open = await waitFor('media folder', () => Array.from(document.querySelectorAll('tbody button')).find((b) => (b.textContent || '').trim() === 'media'));
  open.click();
  (await button('Smart playlist')).click();
  let rules = [];
  for (let i = 0; i < 40 && !rules.some((r) => r.folderPath); i += 1) { rules = await window.newamp.getSmartPlaylistRules(); await sleep(100); }
  const folderRule = rules.find((r) => r.folderPath);
  const ruleTracks = folderRule ? await window.newamp.runSmartPlaylistRule(folderRule.id) : [];
  (await button('Show in Library')).click();
  await waitFor('filtered library', () => document.querySelectorAll('[data-newamp-track-row]').length === 3);
  const search = document.querySelector('[data-newamp-library-search-command] input').value;
  return { rule: folderRule && { name: folderRule.name, folderPath: folderRule.folderPath }, ruleTracks: ruleTracks.map((t) => t.title), search };
`);

clearTimeout(killTimer);
child.kill();
console.log(JSON.stringify(result, null, 2));

const problems = [];
if (!result.created?.listed?.includes('CD Mix')) problems.push('NEW PLAYLIST did not create CD Mix');
if (result.created?.field !== 'CD Mix') problems.push('name field lost the typed name');
if (!result.created?.emptyNote) problems.push('new playlist did not open empty');
if (!result.livePicker?.includes('Second')) problems.push('row picker did not pick up the new playlist');
if (JSON.stringify(result.added) !== JSON.stringify(['CD Mix:2', 'Second:1'])) problems.push(`unexpected playlists ${JSON.stringify(result.added)}`);
if (JSON.stringify(result.afterRemove?.stored) !== JSON.stringify(['Gamma Song'])) problems.push(`removal not saved: ${JSON.stringify(result.afterRemove)}`);
if (result.folder?.rule?.name !== 'media') problems.push(`folder rule not saved: ${JSON.stringify(result.folder)}`);
if (JSON.stringify(result.folder?.ruleTracks) !== JSON.stringify(['Alpha Song', 'Beta Song', 'Gamma Song'])) problems.push('folder rule did not return the folder in order');
if (!/^path:".*media\/"$/.test(result.folder?.search ?? '')) problems.push(`Show in Library search was ${JSON.stringify(result.folder?.search)}`);
if (problems.length) fail(problems.join('; '));
console.log('[ui-playlists-smoke] PASS');
process.exit(0);
