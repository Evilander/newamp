// When the sidebar looks for a music server or a podcast feed
// (src/hooks/useStreamingPresence.ts): once at start, and when the person
// leaves one of the views where they are added, never again once found. The
// hook runs against the real layout store and a small stand-in for React's
// effect scheduling.
//
// Run: node scripts/streaming-presence-test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const deadline = setTimeout(() => { console.error('Streaming presence test timed out'); process.exit(1); }, 30000);
deadline.unref();

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const posix = (path) => path.replace(/\\/g, '/');

function memoryStorage() {
  const data = new Map();
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => { data.set(key, String(value)); }, removeItem: (key) => { data.delete(key); } };
}
Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: memoryStorage() });

// The hook needs `useEffect` and the layout store as a hook; both are replaced
// with versions that run outside a renderer.
const stubs = {
  react: 'export function useEffect(fn, deps) { globalThis.__queue.push({ fn, deps }); }',
  api: 'export const api = globalThis.__api;',
  store: `
    import { useSidebarLayout as real, hasStreamingSources, isStreamingView } from '${posix(repoRoot)}src/store/useSidebarLayout.ts';
    export { hasStreamingSources, isStreamingView };
    export const useSidebarLayout = Object.assign((selector) => selector(real.getState()), real);
  `,
};
const stubPlugin = {
  name: 'presence-stubs',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (!posix(args.importer).endsWith('src/hooks/useStreamingPresence.ts')) return null;
      if (args.path === 'react') return { path: 'react', namespace: 'presence-stub' };
      if (args.path.endsWith('lib/api')) return { path: 'api', namespace: 'presence-stub' };
      if (args.path.endsWith('store/useSidebarLayout')) return { path: 'store', namespace: 'presence-stub' };
      return null;
    });
    b.onLoad({ filter: /.*/, namespace: 'presence-stub' }, (args) => ({ contents: stubs[args.path], loader: 'js', resolveDir: repoRoot }));
  },
};

const bundled = await build({
  stdin: {
    contents: `
      export { useStreamingPresence } from './src/hooks/useStreamingPresence';
      export { useSidebarLayout } from './src/store/useSidebarLayout';
    `,
    resolveDir: repoRoot,
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
  alias: { '@shared': `${posix(repoRoot)}shared` },
  plugins: [stubPlugin],
});

let copies = 0;
// A fresh store and a fresh `api` for each scenario.
async function scenario({ servers = [], feeds = [], used = false, fail = false } = {}) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: memoryStorage(),
  });
  if (used) localStorage.setItem('newamp:sidebar-layout:v1', JSON.stringify({ v: 1, streamingUsed: true }));
  const calls = { servers: 0, feeds: 0 };
  const lists = { servers, feeds };
  globalThis.__api = {
    getMusicServers: async () => { calls.servers += 1; if (fail) throw new Error('offline'); return lists.servers; },
    listPodcastSubscriptions: async () => { calls.feeds += 1; if (fail) throw new Error('offline'); return lists.feeds; },
  };
  const m = await import(`data:text/javascript;base64,${Buffer.from(`${bundled.outputFiles[0].text}\n// copy ${copies++}`).toString('base64')}`);

  // What React does with effects: run one when its dependencies change, after cleaning up the last run.
  const slots = [];
  const render = (view) => {
    globalThis.__queue = [];
    m.useStreamingPresence(view);
    const queued = globalThis.__queue;
    queued.forEach(({ fn, deps }, index) => {
      const slot = slots[index];
      const same = slot && deps && slot.deps && deps.length === slot.deps.length && deps.every((dep, i) => Object.is(dep, slot.deps[i]));
      if (same) return;
      slot?.cleanup?.();
      slots[index] = { deps, cleanup: fn() };
    });
  };
  const unmount = () => { for (const slot of slots) slot?.cleanup?.(); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return {
    render, unmount, settle, calls, lists,
    used: () => m.useSidebarLayout.getState().streamingUsed,
  };
}

// ── start-up ───────────────────────────────────────────────────────────────
{
  const s = await scenario();
  s.render('home');
  await s.settle();
  assert.deepEqual(s.calls, { servers: 1, feeds: 1 }, 'one look at start, both lists');
  assert.equal(s.used(), false, 'nothing found, so Streaming stays collapsed');

  // Moving around the library costs nothing.
  for (const view of ['library', 'albums', 'artists', 'history', 'settings', 'home']) s.render(view);
  await s.settle();
  assert.deepEqual(s.calls, { servers: 1, feeds: 1 }, 'a view change is not a reason to ask again');
  s.render('home');
  assert.deepEqual(s.calls, { servers: 1, feeds: 1 }, 'nor is a render that changes nothing');
}

// ── a server added in its own view ─────────────────────────────────────────
{
  const s = await scenario();
  s.render('home');
  await s.settle();
  s.render('music-servers');
  await s.settle();
  assert.equal(s.calls.servers, 1, 'opening the view does not look: nothing has been added yet');
  s.lists.servers = [{ id: 'one' }];
  s.render('music-servers');
  await s.settle();
  assert.equal(s.calls.servers, 1, 'nor does staying in it');
  s.render('home');
  await s.settle();
  assert.equal(s.calls.servers, 2, 'leaving it does');
  assert.equal(s.used(), true, 'and Streaming opens');

  s.render('podcasts');
  s.render('library');
  await s.settle();
  assert.equal(s.calls.servers, 2, 'once found it never asks again');
  s.unmount();
  assert.equal(s.calls.servers, 2);
}

// ── a feed, and a visit that adds nothing ──────────────────────────────────
{
  const s = await scenario();
  s.render('library');
  await s.settle();
  s.render('podcasts');
  s.render('library');
  await s.settle();
  assert.equal(s.calls.feeds, 2);
  assert.equal(s.used(), false, 'a visit that added nothing finds nothing');
  s.lists.feeds = [{ id: 'feed' }];
  s.render('podcasts');
  s.render('radio');
  await s.settle();
  assert.equal(s.used(), true, 'moving between streaming views also counts as leaving one');
}

// ── Radio ──────────────────────────────────────────────────────────────────
{
  const s = await scenario();
  s.render('radio');
  assert.equal(s.used(), true, 'stations are not saved, so being in Radio is the sign of one');
  await s.settle();
  const before = { ...s.calls };
  s.render('home');
  await s.settle();
  assert.deepEqual(s.calls, before, 'and nothing is looked up after');
}

// ── already open, offline ──────────────────────────────────────────────────
{
  const s = await scenario({ used: true });
  s.render('home');
  s.render('music-servers');
  s.render('home');
  await s.settle();
  assert.deepEqual(s.calls, { servers: 0, feeds: 0 }, 'a library that has used Streaming never asks');

  const offline = await scenario({ fail: true });
  offline.render('home');
  offline.render('radio');
  offline.render('home');
  await offline.settle();
  assert.equal(offline.used(), true, 'Radio still counts while the lookups fail');
  const failing = await scenario({ fail: true });
  failing.render('home');
  failing.render('podcasts');
  failing.render('home');
  await failing.settle();
  assert.equal(failing.used(), false, 'a failed lookup finds nothing, and does not throw');
}

console.log(JSON.stringify({ ok: true }, null, 2));
