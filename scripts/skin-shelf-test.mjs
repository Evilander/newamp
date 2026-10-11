// The skin shelf (src/lib/skin-shelf.ts): the place a custom skin goes when an
// import, a dropped file or a save under a new name is about to replace it.
//
// Run: node scripts/skin-shelf-test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const deadline = setTimeout(() => { console.error('Skin shelf test timed out'); process.exit(1); }, 30000);
deadline.unref();

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  stdin: { contents: "export * from './src/lib/skin-shelf';", resolveDir: repoRoot, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
  alias: { '@shared': `${repoRoot}shared` },
});
// The shelf keeps a cache of what it last read, so each test group gets its own copy.
let copies = 0;
const load = () => import(`data:text/javascript;base64,${Buffer.from(`${bundled.outputFiles[0].text}\n// copy ${copies++}`).toString('base64')}`);
const m = await load();

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => { data.set(key, String(value)); }, data };
}

const skin = (name, accent = '#ff0000', extra = {}) => ({
  name, baseTheme: 'midnight', updatedAt: 1,
  variables: { '--bg': '#101010', '--accent': accent, '--ink': '#eeeeee', ...extra },
});

// ── same colours ───────────────────────────────────────────────────────────
assert.equal(m.sameSkinColours({ '--accent': '#FF0000' }, { '--accent': '#ff0000' }), true, 'case does not matter');
assert.equal(m.sameSkinColours({ '--accent': 'rgba(1, 2, 3, 0.5)' }, { '--accent': 'rgba(1,2,3,0.5)' }), true, 'nor spacing');
assert.equal(m.sameSkinColours({ '--accent': '#ff0000' }, { '--accent': '#ff0001' }), false);
assert.equal(m.sameSkinColours({ '--accent': '#ff0000' }, { '--accent': '#ff0000', '--ink': '#000000' }), false, 'an extra variable is a difference');
assert.equal(m.sameSkinColours({ '--unknown': '#fff' }, {}), true, 'only skin variables count');

// ── names ──────────────────────────────────────────────────────────────────
assert.equal(m.uniqueShelfName('Mine', []), 'Mine');
assert.equal(m.uniqueShelfName('Mine', ['mine']), 'Mine (2)', 'case-insensitive');
assert.equal(m.uniqueShelfName('Mine', ['Mine', 'Mine (2)']), 'Mine (3)');
assert.ok(m.uniqueShelfName('x'.repeat(80), ['x'.repeat(80)]).length <= 80, 'a long name stays inside the limit');

// ── putting skins on the shelf ─────────────────────────────────────────────
{
  let shelf = [];
  shelf = m.shelveSkin(shelf, skin('One'));
  shelf = m.shelveSkin(shelf, skin('Two', '#00ff00'));
  assert.deepEqual(shelf.map((entry) => entry.name), ['Two', 'One'], 'newest first');
  shelf = m.shelveSkin(shelf, skin('One'));
  assert.deepEqual(shelf.map((entry) => entry.name), ['One', 'Two'], 'the same skin again moves to the front instead of doubling');
  shelf = m.shelveSkin(shelf, skin('One', '#0000ff'));
  assert.deepEqual(shelf.map((entry) => entry.name), ['One (2)', 'One', 'Two'], 'a different skin under a taken name is kept under a new one');
  assert.equal(shelf[0].variables['--accent'], '#0000ff');
  assert.equal(shelf[1].variables['--accent'], '#ff0000', 'and the old one is untouched');

  const before = shelf;
  assert.deepEqual(m.shelveSkin(shelf, { name: 'Broken', baseTheme: 'classic', variables: {}, updatedAt: 1 }), before, 'a skin with no valid colours is not shelved');
  assert.deepEqual(m.shelveSkin(shelf, null), before);
  assert.equal(shelf.length, 3);
  assert.deepEqual(m.unshelveSkin(shelf, 'One').map((entry) => entry.name), ['One (2)', 'Two']);
  assert.deepEqual(m.unshelveSkin(shelf, 'nope').length, 3);

  let full = [];
  for (let i = 0; i < 12; i += 1) full = m.shelveSkin(full, skin(`Skin ${i}`, `#0000${(i + 16).toString(16)}`));
  assert.equal(full.length, m.SKIN_SHELF_LIMIT, 'the shelf has a limit');
  assert.equal(full[0].name, 'Skin 11');
  assert.equal(full.at(-1).name, `Skin ${12 - m.SKIN_SHELF_LIMIT}`, 'the oldest fall off');

  const rejected = m.shelveSkin([], skin('Odd', 'javascript:alert(1)', { '--ink': 'url(https://example.com/x)' }));
  assert.deepEqual(Object.keys(rejected[0].variables).sort(), ['--bg'], 'values the skin grammar rejects never reach the shelf');
}

// ── reading what was saved ─────────────────────────────────────────────────
{
  const good = { v: 1, skins: [skin('A'), skin('B', '#00ff00')] };
  assert.deepEqual(m.normalizeSkinShelf(good).map((entry) => entry.name), ['A', 'B']);
  for (const junk of [null, undefined, 'text', 42, [], {}, { v: 2, skins: [skin('A')] }, { v: 1 }, { v: 1, skins: 'no' }]) {
    assert.deepEqual(m.normalizeSkinShelf(junk), [], `unreadable input (${JSON.stringify(junk)}) is an empty shelf`);
  }
  assert.deepEqual(
    m.normalizeSkinShelf({ v: 1, skins: [skin('A'), 7, null, { name: 'x' }, skin('a', '#111111'), skin('C')] }).map((entry) => entry.name),
    ['A', 'C'],
    'junk entries and repeated names are dropped',
  );
  const many = { v: 1, skins: Array.from({ length: 30 }, (_, i) => skin(`S${i}`)) };
  assert.equal(m.normalizeSkinShelf(many).length, m.SKIN_SHELF_LIMIT);
}

// ── storage ────────────────────────────────────────────────────────────────
{
  const fresh = await load();
  const storage = memoryStorage();
  assert.deepEqual(fresh.loadSkinShelf(storage), []);
  assert.equal(fresh.shelfSkin(skin('Kept'), storage), 'Kept');
  assert.equal(fresh.shelfSkin(skin('Kept', '#00ff00'), storage), 'Kept (2)', 'the stored name is returned');
  assert.deepEqual(fresh.loadSkinShelf(storage).map((entry) => entry.name), ['Kept (2)', 'Kept']);
  const stored = JSON.parse(storage.data.get('newamp:skin-shelf:v1'));
  assert.equal(stored.v, 1, 'the key and the record are both versioned');
  assert.equal(fresh.shelfSkin({ name: 'Bad', baseTheme: 'classic', variables: {}, updatedAt: 1 }, storage), null);

  let notified = 0;
  const off = fresh.subscribeSkinShelf(() => { notified += 1; });
  const seen = fresh.getSkinShelf();
  assert.equal(fresh.getSkinShelf(), seen, 'the same array until something changes');
  fresh.removeFromShelf('Kept', storage);
  assert.equal(notified, 1, 'subscribers hear about a change');
  assert.notEqual(fresh.getSkinShelf(), seen);
  assert.deepEqual(fresh.getSkinShelf().map((entry) => entry.name), ['Kept (2)']);
  off();
  fresh.removeFromShelf('Kept (2)', storage);
  assert.equal(notified, 1, 'and stop when they unsubscribe');

  // A broken or blocked store never throws.
  assert.deepEqual(fresh.loadSkinShelf(memoryStorage({ 'newamp:skin-shelf:v1': '{not json' })), []);
  assert.deepEqual(fresh.loadSkinShelf({ getItem: () => { throw new Error('blocked'); }, setItem() {} }), []);
  assert.doesNotThrow(() => fresh.shelfSkin(skin('X'), { getItem: () => null, setItem: () => { throw new Error('quota'); } }));
  assert.doesNotThrow(() => fresh.shelfSkin(skin('Y'), null));
  assert.equal(fresh.loadSkinShelf(null).length, 0);
}

// ── when a save would lose a skin ──────────────────────────────────────────
{
  const mine = skin('Mine');
  assert.equal(m.needsShelving(null, skin('New', '#00ff00'), false), false, 'nothing to lose');
  assert.equal(m.needsShelving(undefined, skin('New'), true), false);
  assert.equal(m.needsShelving(mine, skin('Other', '#00ff00'), false), true, 'an import over a skin');
  assert.equal(m.needsShelving(mine, skin('Mine', '#00ff00'), false), true, 'even one with the same name');
  assert.equal(m.needsShelving(mine, skin('Mine', '#00ff00'), true), false, 'editing a skin in place replaces nothing');
  assert.equal(m.needsShelving(mine, skin('Renamed', '#00ff00'), true), true, 'a rename leaves the old skin behind');
  assert.equal(m.needsShelving(mine, skin('Copy'), false), false, 'the same colours lose nothing');
}

// ── applying a skin without losing the one it replaces ─────────────────────
{
  const run = async (current, incoming) => {
    const log = { current, saved: [], shelved: [], unshelved: [], toasts: [] };
    const deps = {
      current: () => log.current,
      save: async (next) => { log.saved.push(next.name); log.current = next; },
      shelve: (previous) => { log.shelved.push(previous.name); return previous.name === 'Mine' ? 'Mine (2)' : previous.name; },
      unshelve: (name) => { log.unshelved.push(name); },
      notify: (toast) => { log.toasts.push(toast); },
    };
    log.result = await m.applySkinKeepingPrevious(incoming, deps);
    return log;
  };

  const none = await run(null, skin('Fresh'));
  assert.deepEqual(none.saved, ['Fresh']);
  assert.deepEqual(none.shelved, [], 'the first custom skin shelves nothing');
  assert.equal(none.toasts.length, 0);
  assert.equal(none.result, null);

  const replaced = await run(skin('Mine'), skin('Dropped', '#00ff00'));
  assert.deepEqual(replaced.shelved, ['Mine'], 'the skin that was there is kept');
  assert.deepEqual(replaced.saved, ['Dropped']);
  assert.equal(replaced.result.name, 'Mine');
  assert.equal(replaced.toasts.length, 1);
  assert.equal(replaced.toasts[0].title, 'Applied Dropped');
  assert.match(replaced.toasts[0].detail, /Mine \(2\) is saved under Previous skins/, 'the toast names the shelf entry');
  assert.equal(replaced.toasts[0].action.label, 'Undo');
  replaced.toasts[0].action.onClick();
  await new Promise(setImmediate);
  assert.deepEqual(replaced.saved, ['Dropped', 'Mine'], 'undo puts the old skin back');
  assert.deepEqual(replaced.unshelved, ['Mine (2)'], 'and takes it off the shelf, as it is active again');
  assert.equal(replaced.current.name, 'Mine');

  const same = await run(skin('Mine'), skin('Copy'));
  assert.deepEqual(same.shelved, [], 'importing a skin with the same colours shelves nothing');
  assert.equal(same.toasts.length, 0);

  // Dropping several files in a row: each one keeps the one before.
  const chain = { current: skin('Mine'), shelved: [] };
  const chainDeps = {
    current: () => chain.current,
    save: async (next) => { chain.current = next; },
    shelve: (previous) => { chain.shelved.push(previous.name); return previous.name; },
    unshelve() {}, notify() {},
  };
  await m.applySkinKeepingPrevious(skin('First', '#00ff00'), chainDeps);
  await m.applySkinKeepingPrevious(skin('Second', '#0000ff'), chainDeps);
  assert.deepEqual(chain.shelved, ['Mine', 'First'], 'nothing in the middle of a multi-file drop is lost');
  assert.equal(chain.current.name, 'Second');
}

// ── a save that fails keeps nothing on the shelf ───────────────────────────
{
  const shelved = [];
  const notices = [];
  const deps = {
    current: () => skin('Mine'),
    save: async () => { throw new Error('disk full'); },
    shelve: (previous) => { shelved.push(previous.name); return previous.name; },
    unshelve() {},
    notify: (toast) => { notices.push(toast); },
  };
  await assert.rejects(() => m.applySkinKeepingPrevious(skin('Dropped', '#00ff00'), deps), /disk full/);
  assert.deepEqual(shelved, [], 'the skin still in use is not shelved as if it had been replaced');
  assert.equal(notices.length, 0, 'and nothing says it was');

  const order = [];
  await m.applySkinKeepingPrevious(skin('Dropped', '#00ff00'), {
    current: () => skin('Mine'),
    save: async () => { order.push('save'); },
    shelve: (previous) => { order.push('shelve'); return previous.name; },
    unshelve() {}, notify() {},
  });
  assert.deepEqual(order, ['save', 'shelve'], 'the old skin is kept once the new one is saved');
}

// ── using a skin from the shelf, then undoing it ───────────────────────────
{
  const state = { current: skin('Mine'), shelf: [skin('Old', '#00ff00')], toasts: [] };
  const deps = {
    current: () => state.current,
    save: async (next) => { state.current = next; },
    shelve: (previous) => { state.shelf = m.shelveSkin(state.shelf, previous); return state.shelf[0].name; },
    unshelve: (name) => { state.shelf = m.unshelveSkin(state.shelf, name); },
    notify: (toast) => { state.toasts.push(toast); },
  };
  const names = () => state.shelf.map((entry) => entry.name);

  await m.applySkinKeepingPrevious(state.shelf[0], deps, { fromShelf: true });
  assert.equal(state.current.name, 'Old', 'the shelved skin is the active one');
  assert.deepEqual(names(), ['Mine'], 'it left the shelf and the skin it replaced took its place');

  state.toasts[0].action.onClick();
  await new Promise(setImmediate);
  assert.equal(state.current.name, 'Mine', 'undo puts the old skin back');
  assert.deepEqual(names(), ['Old'], 'and the skin that was used is on the shelf again, not lost');

  // Using a shelved skin that has the colours of the one in use replaces nothing.
  const same = { current: skin('Mine'), shelf: [skin('Copy')], notified: 0 };
  await m.applySkinKeepingPrevious(same.shelf[0], {
    current: () => same.current,
    save: async (next) => { same.current = next; },
    shelve: () => { throw new Error('nothing to shelve'); },
    unshelve: (name) => { same.shelf = m.unshelveSkin(same.shelf, name); },
    notify: () => { same.notified += 1; },
  }, { fromShelf: true });
  assert.deepEqual(same.shelf, [], 'it still leaves the shelf');
  assert.equal(same.notified, 0, 'with no undo to offer');

  // Names that collide: the skin in use and the shelved one share a name.
  const clash = { current: skin('Mine'), shelf: [skin('Mine', '#00ff00')] };
  await m.applySkinKeepingPrevious(clash.shelf[0], {
    current: () => clash.current,
    save: async (next) => { clash.current = next; },
    shelve: (previous) => { clash.shelf = m.shelveSkin(clash.shelf, previous); return clash.shelf[0].name; },
    unshelve: (name) => { clash.shelf = m.unshelveSkin(clash.shelf, name); },
    notify() {},
  }, { fromShelf: true });
  assert.equal(clash.current.variables['--accent'], '#00ff00');
  assert.deepEqual(clash.shelf.map((entry) => [entry.name, entry.variables['--accent']]), [['Mine (2)', '#ff0000']], 'the used skin leaves, the replaced one is kept under a free name');
}

// ── dropped skins go through the shelf ─────────────────────────────────────
{
  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const app = await read('../src/App.tsx');
  assert.match(app, /^import \{ applyImportedSkin \} from '\.\/lib\/skin-import';$/m, 'App imports the shelf-keeping apply up front');
  assert.doesNotMatch(app, /await import\('\.\/lib\/skin-import'\)/, 'a chunk that fails to load cannot stall a drop');
  const drop = app.slice(app.indexOf('async function handleDroppedFiles'));
  assert.match(drop.slice(0, drop.indexOf('mediaPaths.length')), /await applyImportedSkin\(skin\);/, 'each dropped skin is applied through it');
  const settings = await read('../src/components/views/SettingsView.tsx');
  assert.match(settings, /await applyImportedSkin\(skin, \{ fromShelf: true \}\);/, 'the Use button on a previous skin says where the skin came from');
}

console.log(JSON.stringify({ ok: true }, null, 2));
