// Rules behind the Library view's queueing and the windowed lists:
//   - playing from the Library queues past the loaded page (readRemainingRows),
//   - a second play cancels the read still paging behind the first,
//   - the visible-row window math used by the queue and playlist lists.
//
// Run: node scripts/views-queue-test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

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

console.log('[views-queue-test] PASS');
