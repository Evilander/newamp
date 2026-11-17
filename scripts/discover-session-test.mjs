import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Mount the actual view with a small hook host and inert UI leaves. Playback
// itself is exercised against the real store by audio-state-regressions-test.
const root = resolve('tmp/discover-session-test');
await mkdir(root, { recursive: true });
const host = resolve(root, 'host.mjs');
await writeFile(host, `
let slots = [], cursor = 0, effects = [], pending = false;
export const calls = [];
const scanListeners = new Set(), removalListeners = new Set();
export function scan(progress) { for (const cb of scanListeners) cb(progress); }
export function remove(ids) { for (const cb of removalListeners) cb(ids); }
export const jsx = (type, props) => ({ type, props });
export const jsxs = jsx;
export const Fragment = Symbol("Fragment");
export let player = { current: null };
export let roots = ['/chosen'];
export let build;
export function setBuild(fn) { build = fn; }
export function setCurrent(track) { player.current = track; }
export function setRoots(next) { roots = next; }
export function useState(initial) {
  const i = cursor++;
  if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
  return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; pending = true; }];
}
export function useRef(value) { return useState(() => ({ current: value }))[0]; }
export function useMemo(fn) { return fn(); }
export function useEffect(fn, deps) {
  const i = cursor++;
  const prev = slots[i];
  if (!prev || deps.some((dep, index) => dep !== prev.deps[index])) {
    effects.push(() => { prev?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
  }
}
export async function render(Component) {
  let tree;
  do {
    pending = false; cursor = 0; tree = Component();
    for (const effect of effects.splice(0)) effect();
    await new Promise(resolve => setImmediate(resolve));
  } while (pending);
  return tree;
}
export function unmount() { for (const slot of slots) slot?.cleanup?.(); slots = []; }
export const api = {
  onTracksRemoved: cb => { removalListeners.add(cb); return () => removalListeners.delete(cb); },
  onScanProgress: cb => { scanListeners.add(cb); return () => scanListeners.delete(cb); },
  getSettings: async () => ({ libraryRoots: roots }),
  getDiscoverSurface: async input => { calls.push(input); return build(input); },
};
export function usePlayerStore(select) { return select(player); }
usePlayerStore.getState = () => player;
export function TrackTable() {}
export function ViewOnboarding() {}
export function HelpDot() {}
export function useViewHelp() { return {}; }
export const playDiscoverQueue = async () => {};
export const pushToast = () => {};
`);
const outfile = resolve(root, 'view.mjs');
await build({
  entryPoints: ['src/components/views/DiscoverView.tsx'], outfile, bundle: true,
  format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
  plugins: [{ name: 'view-host', setup(b) {
    b.onResolve({ filter: /^(react(?:\/jsx-runtime)?|.*\/api|.*usePlayerStore|.*LibraryView|.*ViewOnboarding|.*discover-playback|.*\/toast)$/ }, args => {
      return { path: pathToFileURL(host).href, external: true };
    });
  } }],
});
const harness = await import(pathToFileURL(host).href);
const { DiscoverView } = await import(pathToFileURL(outfile).href);
const track = id => ({ id, path: `/chosen/${id}.flac`, title: `Track ${id}`, artist: 'Artist', album: 'Album', duration: 180 });
let buildNumber = 0;
harness.setBuild(input => {
  buildNumber += 1;
  const tracks = [1, 2, 3, 4].map(id => track(id + buildNumber * 10));
  const mission = { id: 'daily-crate', title: 'Daily Crate', tone: 'accent', tracks, steps: [], visualPlan: null };
  return { seed: input.seed, summary: { trackCount: 4, albumCount: 1 }, missions: [mission], cards: [{ ...mission, id: 'radar', title: 'Radar', tracks: [track(900 + buildNumber)] }] };
});
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  const children = tree.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}
const table = tree => find(tree, node => node.type === harness.TrackTable).props.tracks.map(t => t.id);
harness.setCurrent(track(77));
let tree = await harness.render(DiscoverView);
assert.equal(harness.calls[0].seedTrackId, 77);
assert.match(harness.calls[0].seed, /^\d{4}-\d{1,2}-\d{1,2}$/, "the day's first set is seeded by the date, as in 2.10.0");
assert.equal(harness.calls[0].previousTrackIds, undefined);
const shown = table(tree);
for (const id of shown) {
  harness.setCurrent(track(id));
  tree = await harness.render(DiscoverView);
  await new Promise(resolve => setTimeout(resolve, 650));
  tree = await harness.render(DiscoverView);
  assert.deepEqual(table(tree), shown, 'Play and Next must not replace or remove displayed tracks');
}
assert.equal(harness.calls.length, 1, 'track changes do not rebuild the mission');
find(tree, node => node.props?.['data-newamp-discover-card'] === 'radar').props.onClick();
tree = await harness.render(DiscoverView);
assert.deepEqual(table(tree), [901], 'a Mix Card shows its own tracks instead of the active mission');
find(tree, node => node.props?.['data-newamp-discover-mission'] === 'daily-crate').props.onClick();
tree = await harness.render(DiscoverView);
assert.deepEqual(table(tree), shown, 'returning to the mission preserves its snapshot');
const lightViz = find(tree, node => node.type === 'button' && node.props.children === 'Light Viz');
lightViz.props.onClick();
tree = await harness.render(DiscoverView);
assert.deepEqual(table(tree), shown, 'Light Viz changes only visuals');
harness.unmount();
tree = await harness.render(DiscoverView);
assert.deepEqual(table(tree), shown, 'navigation preserves the session snapshot');
assert.equal(harness.calls.length, 1);
const reshuffle = find(tree, node => node.type === 'button' && node.props.children === 'Reshuffle');
reshuffle.props.onClick();
tree = await harness.render(DiscoverView);
assert.notDeepEqual(table(tree), shown, 'explicit Reshuffle builds a new set');
assert.deepEqual(harness.calls.at(-1).previousTrackIds, shown, 'reshuffle avoids the displayed tracks');
const reshuffled = harness.calls.at(-1).seed;
assert.notEqual(reshuffled, harness.calls[0].seed, 'with a seed of its own');
harness.unmount();
harness.setRoots(['/other']);
await harness.render(DiscoverView);
assert.equal(harness.calls.length, 3, 'a folder change discards the old snapshot');
harness.scan({ done: false });
await harness.render(DiscoverView);
assert.equal(harness.calls.length, 3, 'scan progress does not rebuild');
harness.scan({ done: true });
await harness.render(DiscoverView);
assert.equal(harness.calls.length, 4, 'a finished scan rebuilds');
assert.equal(harness.calls.at(-1).seed, harness.calls[0].seed, "a change of folders starts again from the day's set");
assert.equal(harness.calls.at(-1).previousTrackIds, undefined);
assert.equal(harness.calls.at(-1).seedTrackId, harness.player.current.id, 'build uses the track playing now');
harness.remove([1]);
await harness.render(DiscoverView);
assert.equal(harness.calls.length, 5, 'folder removal rebuilds');
harness.unmount();
harness.scan({ done: true });
await harness.render(DiscoverView);
assert.equal(harness.calls.length, 6, 'scan while away invalidates navigation cache');
harness.unmount();
harness.remove([2]);
await harness.render(DiscoverView);
assert.equal(harness.calls.length, 7, 'removal while away invalidates navigation cache');
// The scan listener is registered once; it must read Light Viz as it is now.
const wasLight = harness.calls.at(-1).lowEndMode;
find(tree = await harness.render(DiscoverView), node => node.type === 'button' && node.props.children === 'Light Viz').props.onClick();
await harness.render(DiscoverView);
harness.scan({ done: true });
await harness.render(DiscoverView);
assert.equal(harness.calls.length, 8);
assert.equal(harness.calls.at(-1).lowEndMode, !wasLight, 'a rebuild after a scan uses the Light Viz setting as it is now');
// A scan after a Reshuffle gives back the reshuffled set, not the day's first one.
tree = await harness.render(DiscoverView);
const before = table(tree);
find(tree, node => node.type === 'button' && node.props.children === 'Reshuffle').props.onClick();
await harness.render(DiscoverView);
const kept = harness.calls.at(-1).seed;
assert.notEqual(kept, harness.calls[0].seed);
harness.scan({ done: true });
await harness.render(DiscoverView);
assert.equal(harness.calls.at(-1).seed, kept, 'a rebuild after a scan keeps the reshuffled set');
assert.deepEqual(harness.calls.at(-1).previousTrackIds, before);
// A scan that finishes while a Reshuffle is still building does not undo it.
tree = await harness.render(DiscoverView);
const shownNow = table(tree);
find(tree, node => node.type === 'button' && node.props.children === 'Reshuffle').props.onClick();
const asked = harness.calls.at(-1).seed;
harness.scan({ done: true });
await harness.render(DiscoverView);
assert.equal(harness.calls.at(-1).seed, asked, 'the rebuild that overtakes a Reshuffle carries it on');
assert.deepEqual(harness.calls.at(-1).previousTrackIds, shownNow);
harness.unmount();
console.log('PASS Discover session: stable across play, Next, visual changes, navigation; explicit refresh and folder invalidation');
