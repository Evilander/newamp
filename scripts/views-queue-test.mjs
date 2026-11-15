// Rules behind the Library view's queueing and the windowed lists:
//   - playing from the Library queues past the loaded page (readRemainingRows),
//   - a second play cancels the read still paging behind the first,
//   - the visible-row window math used by the queue and playlist lists,
//   - the Library's play-from-row: the rest of the matches follow the loaded
//     rows into the queue only while that queue is still the one just started.
//
// Run: node scripts/views-queue-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { build, transform } from 'esbuild';

const bundled = await build({
  entryPoints: ['src/components/views/libraryTableState.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
  alias: { '@shared': resolve('shared') },
});
const { readRemainingRows, createLatestRequestGate } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64')
);
const windowBundle = await build({
  entryPoints: ['src/hooks/useVirtualRows.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
  external: ['react'],
});
const windowSource = windowBundle.outputFiles[0].text.replace(/from "react"/g, 'from "data:text/javascript,export const useCallback=0,useEffect=0,useRef=0,useState=0"');
const { computeVisibleWindow } = await import(
  'data:text/javascript;base64,' + Buffer.from(windowSource).toString('base64')
);

const row = (id) => ({ id });
const library = Array.from({ length: 5200 }, (_, i) => row(i + 1));
const pager = (calls = [], failAt = null) => async (offset, limit) => {
  calls.push([offset, limit]);
  if (failAt !== null && offset >= failAt) throw new Error('read failed');
  return library.slice(offset, offset + limit);
};

// 1. The rest of a list is read page by page after the loaded rows.
{
  const calls = [];
  const loaded = library.slice(0, 600);
  const result = await readRemainingRows({
    getPage: pager(calls),
    offset: 600,
    total: library.length,
    pageSize: 2000,
    exclude: new Set(loaded.map((track) => track.id)),
    isCurrent: () => true,
  });
  assert.equal(result.error, null);
  assert.equal(result.rows.length, library.length - 600, 'every remaining row is read');
  assert.equal(result.rows[0].id, 601);
  assert.equal(result.rows.at(-1).id, 5200);
  assert.deepEqual(calls, [[600, 2000], [2600, 2000], [4600, 2000]], 'pages follow the offset');
}

// 2. Rows a scan shifted under the offset are not queued twice.
{
  const loaded = library.slice(0, 600);
  const result = await readRemainingRows({
    getPage: pager(),
    offset: 590,
    total: library.length,
    pageSize: 2000,
    exclude: new Set(loaded.map((track) => track.id)),
    isCurrent: () => true,
  });
  assert.equal(result.rows[0].id, 601, 'the ten repeated rows are dropped');
  assert.equal(new Set(result.rows.map((track) => track.id)).size, result.rows.length);
}

// 3. A queue that was replaced while reading gets nothing appended.
{
  let alive = true;
  const result = await readRemainingRows({
    getPage: async (offset, limit) => {
      alive = false;
      return library.slice(offset, offset + limit);
    },
    offset: 600,
    total: library.length,
    pageSize: 2000,
    exclude: new Set(),
    isCurrent: () => alive,
  });
  assert.equal(result, null);
}

// 4. A failing page keeps what was read and reports the error.
{
  const result = await readRemainingRows({
    getPage: pager([], 2600),
    offset: 600,
    total: library.length,
    pageSize: 2000,
    exclude: new Set(),
    isCurrent: () => true,
  });
  assert.equal(result.rows.length, 2000, 'the first page survives');
  assert.match(String(result.error), /read failed/);
}

// 5. Rows removed since the count was taken end the read on a short page.
{
  const calls = [];
  const result = await readRemainingRows({
    getPage: pager(calls),
    offset: 5000,
    total: 9000,
    pageSize: 2000,
    exclude: new Set(),
    isCurrent: () => true,
  });
  assert.equal(result.rows.length, 200);
  assert.equal(calls.length, 1, 'a short page is the end');
}

// 6. The read stops at the row limit and asks for no more than it still needs.
{
  const calls = [];
  const result = await readRemainingRows({
    getPage: pager(calls),
    offset: 600,
    total: library.length,
    pageSize: 2000,
    exclude: new Set(),
    isCurrent: () => true,
    maxRows: 2500,
  });
  assert.equal(result.rows.length, 2500);
  assert.deepEqual(calls, [[600, 2000], [2600, 500]], 'the last page asks for only the rows left under the limit');
}

// 7. A read that fails after the queue was replaced appends nothing.
{
  let alive = true;
  const result = await readRemainingRows({
    getPage: async () => {
      alive = false;
      throw new Error('read failed');
    },
    offset: 600,
    total: library.length,
    pageSize: 2000,
    exclude: new Set(),
    isCurrent: () => alive,
  });
  assert.equal(result, null, 'a stale read reports nothing, not even its error');
}

// 8. Playing a second row while the first read is still paging: only the
// later read may append, so the tail is queued once.
{
  const gate = createLatestRequestGate();
  const queue = library.slice(0, 600);
  let release = () => {};
  const held = new Promise((resolveHeld) => {
    release = resolveHeld;
  });
  const startRead = (getPage) =>
    readRemainingRows({
      getPage,
      offset: 600,
      total: library.length,
      pageSize: 2000,
      exclude: new Set(queue.map((track) => track.id)),
      isCurrent: gate.begin(),
    });
  const first = startRead(async (offset, limit) => {
    await held;
    return library.slice(offset, offset + limit);
  });
  const second = startRead(async (offset, limit) => library.slice(offset, offset + limit));
  const kept = await second;
  release();
  assert.equal(await first, null, 'the earlier read is cancelled by the later play');
  assert.equal(kept.rows.length, library.length - 600);
}

// 9. The window follows the scroll position and keeps its spacers in step.
{
  const win = computeVisibleWindow({ scrollTop: 3600, viewportH: 360, rowHeight: 36, rowCount: 1000, overscan: 6 });
  assert.equal(win.startIndex, 94);
  assert.equal(win.endIndex, 116);
  assert.equal(win.topPad, 94 * 36);
  assert.equal(win.bottomPad, (999 - 116) * 36);
  const end = computeVisibleWindow({ scrollTop: 1e9, viewportH: 360, rowHeight: 36, rowCount: 1000, overscan: 6 });
  assert.equal(end.endIndex, 999, 'the window never runs past the last row');
  assert.equal(end.bottomPad, 0);
  assert.equal(computeVisibleWindow({ scrollTop: 0, viewportH: 360, rowHeight: 36, rowCount: 0, overscan: 6 }).endIndex, -1);
}

// 10. Play from a row: the loaded rows start at once, and the rest of the matches
// are queued behind them unless the queue has changed by then.
{
  const path = 'src/components/views/LibraryView.tsx';
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const find = (root, predicate) => {
    if (predicate(root)) return root;
    let found;
    ts.forEachChild(root, (node) => { found ??= find(node, predicate); });
    return found;
  };
  const functionText = (name) => find(file, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(file);
  const code = (await transform(['queueRestOfList', 'playFromRow'].map(functionText).join('\n'), { loader: 'tsx' })).code;

  async function playFrom(setup = {}) {
    const store = { queue: [], index: -1, added: [] };
    const toasts = [];
    const gate = { reads: 0, hold: null };
    const ctx = vm.createContext({
      tracks: library.slice(0, 600),
      rowsReadRef: { current: 600 },
      hasMoreTracks: true,
      playRequestGateRef: { current: createLatestRequestGate() },
      // startQueuePlayback sets the queue before it returns.
      playQueue: async (played, index) => { store.queue = played; store.index = index; },
      libraryQuery: '',
      sort: 'artist',
      readRemainingRows,
      matchingCountRef: { current: library.length },
      LIBRARY_MORE_PAGE_SIZE: 2000,
      LIBRARY_QUEUE_LIMIT: 20000,
      api: {
        getTracks: async ({ offset, limit }) => {
          gate.reads += 1;
          if (gate.hold && gate.reads === 1) await gate.hold;
          return library.slice(offset, offset + limit);
        },
      },
      usePlayerStore: { getState: () => ({ queue: store.queue, addTracksToQueue: (rows) => store.added.push(...rows) }) },
      window: { setTimeout: (callback) => setTimeout(callback, 0) },
      pushToast: (toast) => toasts.push(toast),
      errorText: String,
      ...setup,
    });
    vm.runInContext(code, ctx);
    return { ctx, store, toasts, gate };
  }
  const settled = () => new Promise((resolveSettled) => setTimeout(resolveSettled, 60));

  // The rows on screen play at once, and the rest of the list is queued after them.
  {
    const { ctx, store, gate } = await playFrom();
    ctx.playFromRow(3);
    assert.equal(store.queue.length, 600, 'the loaded rows are the queue straight away');
    assert.equal(store.index, 3);
    await settled();
    assert.equal(store.added.length, library.length - 600);
    assert.equal(store.added[0].id, 601, 'the tail starts where the loaded rows end');
    assert.equal(gate.reads, 3);
  }

  // A list that holds every match has nothing to read behind it.
  {
    const { ctx, store, gate } = await playFrom({ hasMoreTracks: false });
    ctx.playFromRow(0);
    await settled();
    assert.equal(gate.reads, 0);
    assert.equal(store.added.length, 0);
  }

  // A queue replaced, or cut at its end, while the tail was being read gets nothing appended.
  for (const [what, change] of [
    ['replaced', (store) => { store.queue = library.slice(1000, 1010); }],
    ['started on another track', (store) => { store.queue = store.queue.slice(1); }],
    ['stripped of its last track', (store) => { store.queue = store.queue.slice(0, -1); }],
  ]) {
    let release;
    const hold = new Promise((resolveHold) => { release = resolveHold; });
    const { ctx, store, gate } = await playFrom();
    gate.hold = hold;
    ctx.playFromRow(0);
    await settled();
    change(store);
    release();
    await settled();
    assert.equal(store.added.length, 0, `a queue ${what} meanwhile is left alone`);
  }

  // Playing a second row before the first tail is read queues one tail, behind the later play.
  {
    let release;
    const hold = new Promise((resolveHold) => { release = resolveHold; });
    const { ctx, store, gate } = await playFrom();
    gate.hold = hold;
    ctx.playFromRow(0);
    await settled();
    ctx.playFromRow(5);
    release();
    await settled();
    assert.equal(store.index, 5);
    assert.equal(store.added.length, library.length - 600, 'the tail is queued once');
  }

  // A long list stops at the queue limit and says how much it queued.
  {
    const { ctx, store, toasts } = await playFrom({ LIBRARY_QUEUE_LIMIT: 1000 });
    ctx.playFromRow(0);
    await settled();
    assert.equal(store.added.length, 400, 'the limit counts the rows already queued');
    assert.match(toasts[0].title, /^Queued 1[^0-9]?000 of 5[^0-9]?200 tracks$/);
  }
}

console.log('[views-queue-test] PASS');
