// Unit tests for electron/window-state.ts and its settings round trip: where
// the main window and the deck reopen, including after a monitor is gone.
// Run: node scripts/window-state-test.mjs
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/window-state-test-result.txt');
writeFileSync(RESULT, '[window-state-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

const bundle = async (entry, name) => {
  const outfile = resolve(`tmp/${name}-bundle.mjs`);
  await build({
    entryPoints: [resolve(entry)],
    bundle: true, format: 'esm', platform: 'node', target: 'es2022',
    outfile, logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
};
const { placeWindow, placeOrigin, nextWindowState, normalizeWindowState, normalizeWindowRect, emptyWindowState } =
  await bundle('electron/window-state.ts', 'window-state');
const { SettingsStore } = await bundle('electron/settings.ts', 'window-state-settings');

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const same = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  log.push(`${label}: ${a}`);
  if (a !== e) fail(`${label} expected ${e}, got ${a}`);
};

const NORMAL = { minWidth: 980, minHeight: 640, defaultWidth: 1280, defaultHeight: 820 };
const DECK = { minWidth: 280, minHeight: 100, defaultWidth: 720, defaultHeight: 152 };
const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 2560, height: 1400 };
const left = { x: -1600, y: 100, width: 1600, height: 900 };

// Nothing saved: the default size and no position, so the OS centers it.
same('no saved bounds', placeWindow(null, [primary], NORMAL), { width: 1280, height: 820 });
same('garbage bounds', placeWindow({ x: 'a', y: 0, width: 10, height: NaN }, [primary], NORMAL), { width: 1280, height: 820 });

// Still on a connected display: unchanged.
same('on the primary display', placeWindow({ x: 200, y: 120, width: 1300, height: 800 }, [primary], NORMAL),
  { x: 200, y: 120, width: 1300, height: 800 });
same('on the second display', placeWindow({ x: 2200, y: 100, width: 1400, height: 900 }, [primary, second], NORMAL),
  { x: 2200, y: 100, width: 1400, height: 900 });
same('on a display left of the primary', placeWindow({ x: -1500, y: 150, width: 1000, height: 700 }, [left, primary], NORMAL),
  { x: -1500, y: 150, width: 1000, height: 700 });

// The monitor it lived on was unplugged: keep the size, drop the position.
same('second display removed', placeWindow({ x: 2200, y: 100, width: 1400, height: 900 }, [primary], NORMAL),
  { width: 1400, height: 900 });
same('removed display and a smaller primary shrinks the window',
  placeWindow({ x: 2200, y: 100, width: 1900, height: 1200 }, [{ x: 0, y: 0, width: 1366, height: 728 }], NORMAL),
  { width: 1366, height: 728 });
same('only a sliver still overlaps a display', placeWindow({ x: 1880, y: 100, width: 1400, height: 900 }, [primary], NORMAL),
  { width: 1400, height: 900 });

// Mostly on a display but hanging off an edge: pulled fully inside.
same('hanging off the right edge', placeWindow({ x: 1000, y: 100, width: 1300, height: 800 }, [primary], NORMAL),
  { x: 620, y: 100, width: 1300, height: 800 });
same('hanging off the bottom edge', placeWindow({ x: 100, y: 600, width: 1300, height: 800 }, [primary], NORMAL),
  { x: 100, y: 240, width: 1300, height: 800 });
same('above the top edge', placeWindow({ x: 100, y: -300, width: 1300, height: 800 }, [primary], NORMAL),
  { x: 100, y: 0, width: 1300, height: 800 });

// Resolution got smaller than the saved window.
same('window larger than its display', placeWindow({ x: 100, y: 50, width: 1900, height: 1000 }, [{ x: 0, y: 0, width: 1600, height: 900 }], NORMAL),
  { x: 0, y: 0, width: 1600, height: 900 });
same('display smaller than the minimum size', placeWindow({ x: 0, y: 0, width: 1000, height: 650 }, [{ x: 0, y: 0, width: 800, height: 600 }], NORMAL),
  { x: 0, y: 0, width: 980, height: 640 });
// A window straddling two displays belongs to the one holding most of it.
same('straddling two displays picks the larger share', placeWindow({ x: 1500, y: 100, width: 1000, height: 700 }, [primary, second], NORMAL),
  { x: 1920, y: 100, width: 1000, height: 700 });

// The deck: small windows use the deck limits.
same('deck on the primary display', placeWindow({ x: 1700, y: 900, width: 720, height: 152 }, [primary], DECK),
  { x: 1200, y: 888, width: 720, height: 152 });
same('deck on a removed display', placeWindow({ x: 2300, y: 900, width: 720, height: 152 }, [primary], DECK),
  { width: 720, height: 152 });

// Entering the deck keeps the saved corner when it is still on screen.
same('deck origin kept', placeOrigin({ x: 100, y: 800, width: 720, height: 152 }, { width: 720, height: 152 }, [primary]),
  { x: 100, y: 800 });
same('deck origin pulled inside for a wider skin', placeOrigin({ x: 1500, y: 800, width: 720, height: 152 }, { width: 900, height: 200 }, [primary]),
  { x: 1020, y: 800 });
same('deck origin on a removed display', placeOrigin({ x: 2300, y: 800, width: 720, height: 152 }, { width: 720, height: 152 }, [primary]), null);
same('no saved deck origin', placeOrigin(null, { width: 720, height: 152 }, [primary]), null);

// What gets stored after a move or resize.
const fresh = emptyWindowState();
const snap = (over = {}) => ({
  compact: false, maximized: false, fullscreen: false, minimized: false,
  bounds: { x: 10, y: 20, width: 1280, height: 820 },
  normalBounds: { x: 10, y: 20, width: 1280, height: 820 },
  ...over,
});
same('normal window saved', nextWindowState(fresh, snap()),
  { normal: { x: 10, y: 20, width: 1280, height: 820 }, maximized: false, deck: null });
same('unchanged -> nothing to write', nextWindowState({ normal: { x: 10, y: 20, width: 1280, height: 820 }, maximized: false, deck: null }, snap()), null);
same('maximized keeps the restored rectangle', nextWindowState(fresh, snap({
  maximized: true,
  bounds: { x: 0, y: 0, width: 1920, height: 1040 },
})), { normal: { x: 10, y: 20, width: 1280, height: 820 }, maximized: true, deck: null });
same('fullscreen is never recorded', nextWindowState(fresh, snap({ fullscreen: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } })), null);
same('minimized is never recorded', nextWindowState(fresh, snap({ minimized: true, bounds: { x: -32000, y: -32000, width: 160, height: 28 } })), null);
const withNormal = { normal: { x: 10, y: 20, width: 1280, height: 820 }, maximized: true, deck: null };
same('the deck is stored apart from the normal window', nextWindowState(withNormal, snap({
  compact: true,
  bounds: { x: 1500, y: 900, width: 720, height: 152 },
  normalBounds: { x: 1500, y: 900, width: 720, height: 152 },
})), { normal: { x: 10, y: 20, width: 1280, height: 820 }, maximized: true, deck: { x: 1500, y: 900, width: 720, height: 152 } });
same('a normal save keeps the deck spot', nextWindowState({ ...withNormal, maximized: false, deck: { x: 1, y: 2, width: 300, height: 120 } }, snap({ bounds: { x: 50, y: 60, width: 1280, height: 820 }, normalBounds: { x: 50, y: 60, width: 1280, height: 820 } })),
  { normal: { x: 50, y: 60, width: 1280, height: 820 }, maximized: false, deck: { x: 1, y: 2, width: 300, height: 120 } });

same('hand-edited values are discarded', normalizeWindowState({ normal: { x: 1, y: 2, width: 5, height: 5 }, maximized: 'yes', deck: 7 }),
  { normal: null, maximized: false, deck: null });
same('fractions are rounded', normalizeWindowRect({ x: 10.4, y: 20.6, width: 1280.2, height: 820.7 }), { x: 10, y: 21, width: 1280, height: 821 });

// Settings: an older settings.json still loads, the field persists and a bad
// patch cannot store nonsense.
const dir = mkdtempSync(join(tmpdir(), 'newamp-window-state-'));
try {
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ theme: 'classic', volume: 0.5 }));
  const store = new SettingsStore(file);
  same('older settings.json gets the default', store.get().windowState, { normal: null, maximized: false, deck: null });
  store.set({ windowState: { normal: { x: 30, y: 40, width: 1300, height: 800 }, maximized: true, deck: { x: 5, y: 6, width: 720, height: 152 } } });
  // A lone windowState patch is written on a debounce; quitting flushes it.
  store.flushSync();
  const reopened = new SettingsStore(file);
  same('saved state survives a restart', reopened.get().windowState,
    { normal: { x: 30, y: 40, width: 1300, height: 800 }, maximized: true, deck: { x: 5, y: 6, width: 720, height: 152 } });
  reopened.set({ windowState: { normal: { x: 'x' }, maximized: true } });
  same('nonsense patch is normalized', reopened.get().windowState, { normal: null, maximized: true, deck: null });
  reopened.set({ volume: 0.4 });
  same('unrelated patches leave it alone', reopened.get().windowState, { normal: null, maximized: true, deck: null });
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  same('written to settings.json', onDisk.windowState, { normal: null, maximized: true, deck: null });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const report = log.join('\n') + '\n' + (pass ? '[window-state-test] PASS' : '[window-state-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
