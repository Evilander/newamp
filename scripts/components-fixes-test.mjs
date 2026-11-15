// Checks for the renderer component fixes: the scrub bar seeks once per input
// event, the wheel never seeks backwards near the end, the entity links keep
// real artists whose names start with "Unknown", the Quick Play list keeps
// room for tracks and leads with an exact title, and the decks cycle repeat
// the way the transport does.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

async function bundle(entry, { append = '', stubs = {} } = {}) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    plugins: [{
      name: 'a14',
      setup(b) {
        const names = Object.keys(stubs);
        if (names.length) {
          b.onResolve({ filter: new RegExp(`^(${names.map((n) => n.replace(/[.\\/]/g, '\\$&')).join('|')})$`) }, (args) => ({ path: args.path, namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
        }
        if (append) {
          b.onLoad({ filter: new RegExp(entry.replace(/[.\\/]/g, '\\$&') + '$') }, async (args) => ({
            contents: `${await readFile(args.path, 'utf8')}\n${append}`,
            loader: args.path.endsWith('x') ? 'tsx' : 'ts',
          }));
        }
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

const storeStub = "export const usePlayerStore = Object.assign(() => ({}), { getState: () => ({}) });";
const apiStub = "export const api = { platform: 'darwin' };";

// --- ScrubBar: one seek per input event -------------------------------------------------
{
  const source = await read('src/components/ScrubBar.tsx');
  assert.doesNotMatch(source, /onInput=/, 'onChange already fires for every input event of a range input');
  assert.equal(source.match(/onChange=/g)?.length, 1, 'the slider commits from onChange only');

  // Render the slider and fire every commit handler it carries once for one input event, the way React
  // does for a range input. Whatever the handlers are called, the engine must see a single seek.
  const { ScrubBar } = await bundle('src/components/ScrubBar.tsx', {
    stubs: {
      react: 'export const useRef = (initial) => ({ current: initial }); export const useEffect = () => {};',
      'react/jsx-runtime': 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx; export const Fragment = Symbol("Fragment");',
      '../hooks/useWheelSeek': 'export const useWheelSeek = () => {};',
      './WaveformSeek': 'export const WaveformSeek = () => null;',
    },
  });
  const seeks = [];
  const slider = ScrubBar({ value: 10, max: 200, onSeek: (seconds) => seeks.push(seconds) });
  assert.equal(slider.type, 'input');
  const input = { value: '42' };
  for (const name of ['onInput', 'onChange']) slider.props[name]?.({ currentTarget: input });
  assert.deepEqual(seeks, [42], 'one input event commits one seek');
}

// --- Wheel seek near the end of the track ------------------------------------------------
{
  const { createWheelSeek } = await bundle('src/lib/wheel-seek.ts');
  const notch = (deltaY) => ({ deltaY, deltaX: 0, deltaMode: 0 });
  // A step forward inside the last second does not pull the playhead back to the margin.
  let seek = createWheelSeek();
  assert.deepEqual(seek.handle(notch(-100), 1000, 359.5, 360), { consumed: true, target: null });
  assert.deepEqual(seek.handle(notch(-100), 1040, 359.5, 360), { consumed: true, target: null }, 'and neither does the next one');
  seek = createWheelSeek();
  assert.deepEqual(seek.handle(notch(-100), 1000, 360, 360), { consumed: true, target: null });
  // Backwards still works from there, and forwards still stops at the margin.
  seek = createWheelSeek();
  assert.equal(seek.handle(notch(100), 1000, 359.5, 360).target, 354.5);
  seek = createWheelSeek();
  assert.equal(seek.handle(notch(-100), 1000, 357, 360).target, 359, 'a step that crosses the margin stops on it');
}

// --- EntityLink: only the placeholder names are unlinked ---------------------------------
{
  const { ArtistLink, AlbumLink } = await bundle('src/components/EntityLink.tsx', { stubs: { '../store/usePlayerStore': storeStub } });
  const typeOf = (element) => element.type;
  for (const name of ['Unknown Mortal Orchestra', 'Unknown Pleasures']) {
    assert.equal(typeOf(ArtistLink({ artist: name })), 'button', `${name} is a real artist`);
    assert.equal(typeOf(AlbumLink({ album: name, albumArtist: 'x' })), 'button', `${name} is a real album`);
  }
  for (const name of ['', '  ', 'Unknown', 'unknown artist', 'Unknown Album', '<unknown>', '[Unknown]']) {
    assert.equal(typeOf(ArtistLink({ artist: name })), 'span', `${JSON.stringify(name)} stays plain text`);
  }
}

// --- Quick Play: ranking and room for tracks ---------------------------------------------
{
  const { buildPaletteItems } = await bundle('src/components/QuickPlayPalette.tsx', {
    append: 'export { buildPaletteItems };',
    stubs: { '../store/usePlayerStore': storeStub, '../lib/api': apiStub },
  });
  const track = (id, title) => ({ id, title, artist: 'A', album: 'B', albumArtist: 'A', duration: 100 });
  const tracks = Array.from({ length: 24 }, (_, i) => track(i + 1, `Song ${i + 1}`));
  const playlists = Array.from({ length: 8 }, (_, i) => ({ id: i, name: `Mix playlist ${i}`, updatedAt: i, trackCount: 1, duration: 1 }));
  const albums = Array.from({ length: 8 }, (_, i) => ({ albumKey: `k${i}`, album: `Mix album ${i}`, albumArtist: 'A', trackCount: 1 }));
  const artists = Array.from({ length: 8 }, (_, i) => ({ artist: `Mix artist ${i}`, albumCount: 1, trackCount: 1 }));
  const kinds = (items) => items.map((item) => item.kind);
  const count = (items, kind) => kinds(items).filter((k) => k === kind).length;

  // A broad query matches views and commands as well as everything else; tracks still get their rows.
  const broad = buildPaletteItems('a', tracks, playlists, [], albums, artists, 48);
  assert.ok(broad.length <= 48);
  assert.ok(count(broad, 'track') >= 12, `a broad query keeps at least 12 tracks, got ${count(broad, 'track')}`);
  assert.ok(count(broad, 'view') + count(broad, 'command') <= 6, 'views and commands share six rows');

  // An exact title leads, ahead of any view that also matches.
  const exact = buildPaletteItems('library', [track(1, 'Other'), track(2, 'Library')], [], [], [], [], 48);
  assert.equal(exact[0].kind, 'track');
  assert.equal(exact[0].title, 'Library');
  assert.equal(exact[1].kind, 'view', 'the Library view follows');

  // The prefix match of a view outranks a substring match when the six are cut.
  const menu = buildPaletteItems('li', [], [], [], [], [], 48).filter((item) => item.kind === 'view');
  assert.equal(menu[0].title, 'Library');

  // With nothing typed every view stays listed, and the limit leaves the tracks their share.
  const idle = buildPaletteItems('', tracks, playlists, [], [], [], 44);
  assert.equal(count(idle, 'view'), 16);
  assert.ok(count(idle, 'track') >= 12);
  assert.ok(idle.length <= 44);
}

// --- Decks: repeat cycles off, all, one --------------------------------------------------
{
  const { ClassicBentoDeck } = await bundle('src/components/decks/ClassicBentoDeck.tsx', {
    stubs: { '../Visualizer': 'export const Visualizer = () => null;', '../VolumeSlider': 'export const VolumeSlider = () => null;', '../BrandLogo': 'export const BrandLogo = () => null;', './DeckSkinPicker': 'export const DeckSkinPicker = () => null;', '../ScrubBar': 'export const ScrubBar = () => null;', './DeckWindowButtons': 'export const DeckWindowButtons = () => null;', '../../lib/format': 'export const formatTime = () => "0:00";' },
  });
  const modes = [];
  const find = (node, test, found = []) => {
    if (node == null || typeof node !== 'object') return found;
    if (Array.isArray(node)) { node.forEach((child) => find(child, test, found)); return found; }
    if (test(node)) found.push(node);
    find(node.props?.children, test, found);
    return found;
  };
  const props = (mode) => ({ track: null, isPlaying: false, currentTime: 0, duration: 0, volume: 1, mode, alwaysOnTop: false, artUrl: null, vizExpanded: false, onSetMode: (next) => modes.push(next), onPickSkin() {} });
  const press = (mode) => {
    const tree = ClassicBentoDeck(props(mode));
    const rep = find(tree, (node) => node.type === 'button' && typeof node.props.title === 'string' && node.props.title.startsWith('Repeat'));
    assert.equal(rep.length, 1, 'the windowshade has one repeat button');
    rep[0].props.onClick();
  };
  press('normal');
  press('repeat-all');
  press('repeat-one');
  press('shuffle');
  assert.deepEqual(modes, ['repeat-all', 'repeat-one', 'normal', 'shuffle-repeat-all'], 'off, all, one, off, and shuffle is kept');
}

console.log('components-fixes-test: ok');
