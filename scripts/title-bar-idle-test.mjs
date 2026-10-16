// The title bar's idle line must not say "Load your library" over a library
// that is already loaded. It says so only when there are no saved folders and
// no tracks, and anything not known yet reads as the neutral "Nothing playing".
// Runs the real TitleBar against a stub of React's hooks (the repo has no DOM
// test runner).
// Run: node scripts/title-bar-idle-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundleComponent, findAll, mount } from './lib/hook-harness.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const env = {};
const reset = (overrides = {}) => {
  env.state = {
    settings: { libraryRoots: [] },
    current: null,
    isPlaying: false,
    alwaysOnTop: false,
    setCompactMode: () => undefined,
    setAlwaysOnTop: () => undefined,
  };
  env.statsCalls = 0;
  env.stats = async () => ({ tracks: 0, albums: 0, artists: 0, duration: 0 });
  env.scanListeners = new Set();
  env.state = { ...env.state, ...overrides };
};
globalThis.__env = env;

const { TitleBar } = await bundleComponent('src/components/TitleBar.tsx', {
  '../store/usePlayerStore': 'export const usePlayerStore = (select) => select(globalThis.__env.state);',
  '../lib/api': `export const api = {
    platform: 'win32',
    appVersion: '0.0.0',
    getStats: () => { globalThis.__env.statsCalls += 1; return globalThis.__env.stats(); },
    onScanProgress: (cb) => { globalThis.__env.scanListeners.add(cb); return () => globalThis.__env.scanListeners.delete(cb); },
  };
  export const winctl = { onState: () => () => undefined };`,
  './EntityLink': 'export const ArtistLink = () => null;',
  './BrandLogo': 'export const BrandLogo = () => null;',
});

const settle = () => new Promise((resolve) => setImmediate(resolve));
const idleText = (view) => {
  const [line] = findAll(view.output, (node) => typeof node.props?.className === 'string' && node.props.className.includes('text-center'));
  assert.ok(line, 'the title bar renders its centre line');
  return line.props.children;
};
async function show(overrides, setup) {
  reset(overrides);
  setup?.();
  const view = mount(() => TitleBar());
  view.flush();
  await settle();
  view.flush();
  return view;
}

// A library with folders: the 58,001-track case. No claim about loading, and no stats query.
{
  const view = await show({ settings: { libraryRoots: ['K:\\Music'] } });
  assert.equal(idleText(view), 'Nothing playing');
  assert.equal(env.statsCalls, 0, 'saved folders settle it without asking the library');
  view.unmount();
}

// Settings not loaded yet: nothing wrong is said.
{
  const view = await show({ settings: null });
  assert.equal(idleText(view), 'Nothing playing');
  view.unmount();
}

// A new install: no folders, no tracks.
{
  const view = await show({});
  assert.equal(idleText(view), 'Ready. Load your library.');
  view.unmount();
}

// Not known until the library answers, and an answer that cannot be had stays neutral.
{
  reset();
  let answer;
  env.stats = () => new Promise((resolve) => { answer = resolve; });
  const view = mount(() => TitleBar());
  view.flush();
  assert.equal(idleText(view), 'Nothing playing', 'unanswered stats do not read as an empty library');
  answer({ tracks: 0, albums: 0, artists: 0, duration: 0 });
  await settle();
  view.flush();
  assert.equal(idleText(view), 'Ready. Load your library.');
  view.unmount();

  const failing = await show({}, () => { env.stats = async () => { throw new Error('no library'); }; });
  assert.equal(idleText(failing), 'Nothing playing', 'a failed stats read stays neutral');
  failing.unmount();
}

// No saved folders but tracks present (the empty-library screen scans a folder
// without writing the store's settings): the library is loaded.
{
  const view = await show({}, () => { env.stats = async () => ({ tracks: 58001, albums: 4000, artists: 3000, duration: 1 }); });
  assert.equal(idleText(view), 'Nothing playing');
  view.unmount();
}

// A scan that finishes fills the library: the line follows without a restart.
{
  reset();
  const view = mount(() => TitleBar());
  view.flush();
  await settle();
  view.flush();
  assert.equal(idleText(view), 'Ready. Load your library.');
  assert.equal(env.scanListeners.size, 1, 'listens for scan progress while the library may be empty');
  env.stats = async () => ({ tracks: 120, albums: 10, artists: 5, duration: 1 });
  for (const listener of env.scanListeners) listener({ done: false });
  await settle();
  view.flush();
  assert.equal(idleText(view), 'Ready. Load your library.', 'a scan in progress changes nothing yet');
  for (const listener of env.scanListeners) listener({ done: true });
  await settle();
  view.flush();
  assert.equal(idleText(view), 'Nothing playing');
  view.unmount();
  assert.equal(env.scanListeners.size, 0, 'unmounting stops listening');
}

// Adding a folder in Settings (the store's settings change) ends the empty-library line.
{
  reset();
  const view = mount(() => TitleBar());
  view.flush();
  await settle();
  view.flush();
  assert.equal(idleText(view), 'Ready. Load your library.');
  env.state = { ...env.state, settings: { libraryRoots: ['D:\\Music'] } };
  view.flush();
  assert.equal(idleText(view), 'Nothing playing');
  assert.equal(env.scanListeners.size, 0, 'no listener once a folder is saved');
  view.unmount();
}

// A playing track still takes the line.
{
  const view = await show({ current: { artist: 'Boards of Canada', title: 'Roygbiv' } });
  const [line] = findAll(view.output, (node) => typeof node.props?.className === 'string' && node.props.className.includes('text-center'));
  assert.ok(Array.isArray(line.props.children) || typeof line.props.children === 'object', 'the track renders instead of the idle line');
  assert.match(JSON.stringify(line.props.children), /Roygbiv/);
  view.unmount();
}

// The old unconditional line is gone from the source.
{
  const source = read('src/components/TitleBar.tsx');
  assert.equal(source.split('Ready. Load your library.').length - 1, 1, 'the empty-library line appears once, inside idleTitle');
  assert.doesNotMatch(source, /\) : \(\s*'Ready\. Load your library\.'\s*\)\}/, 'the idle line is no longer a bare literal');
}

console.log('PASS title bar idle line');
