// Unit tests for electron/desk-widget.ts and its settings round trip: the
// widget's saved state, what each level asks of the window on each platform,
// and where the widget opens, including after its monitor is gone.
// Run: node scripts/desk-widget-test.mjs
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/desk-widget-test-result.txt');
writeFileSync(RESULT, '[desk-widget-test] starting…\n');
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
const {
  DESK_WIDGET_SIZES, emptyDeskWidgetState, normalizeDeskWidgetState,
  deskWidgetLevels, resolveDeskWidgetLevel, deskWidgetLevelCall, placeDeskWidget,
} = await bundle('electron/desk-widget.ts', 'desk-widget');
const { SettingsStore } = await bundle('electron/settings.ts', 'desk-widget-settings');

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const same = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  log.push(`${label}: ${a}`);
  if (a !== e) fail(`${label} expected ${e}, got ${a}`);
};

// Saved state: anything unreadable falls back to a closed widget.
const empty = emptyDeskWidgetState();
same('empty state', empty, { open: false, layout: 'platter', level: 'desktop', origin: null });
same('garbage', normalizeDeskWidgetState('nope'), empty);
same('null', normalizeDeskWidgetState(null), empty);
same(
  'unknown layout and level',
  normalizeDeskWidgetState({ open: true, layout: 'hologram', level: 'orbit', origin: { x: 10.4, y: 20.6 } }),
  { open: true, layout: 'platter', level: 'desktop', origin: { x: 10, y: 21 } },
);
same('open must be exactly true', normalizeDeskWidgetState({ open: 'yes' }).open, false);
same('origin with a missing axis', normalizeDeskWidgetState({ origin: { x: 5 } }).origin, null);
same('origin off in the weeds', normalizeDeskWidgetState({ origin: { x: 9e9, y: 0 } }).origin, null);
same(
  'a valid state survives',
  normalizeDeskWidgetState({ open: true, layout: 'card', level: 'floating', origin: { x: -300, y: 40 } }),
  { open: true, layout: 'card', level: 'floating', origin: { x: -300, y: 40 } },
);

// Levels: only macOS has one between the desktop and ordinary windows.
same('darwin levels', deskWidgetLevels('darwin'), ['desktop', 'normal', 'floating']);
same('win32 levels', deskWidgetLevels('win32'), ['normal', 'floating']);
same('linux levels', deskWidgetLevels('linux'), ['normal', 'floating']);
same('desktop on win32 is a normal window', resolveDeskWidgetLevel('desktop', 'win32'), 'normal');
same('desktop on darwin stays', resolveDeskWidgetLevel('desktop', 'darwin'), 'desktop');
same('floating is floating everywhere', resolveDeskWidgetLevel('floating', 'linux'), 'floating');
same('darwin desktop call', deskWidgetLevelCall('desktop', 'darwin'), { onTop: true, level: 'normal', relativeLevel: -1 });
same('win32 desktop call', deskWidgetLevelCall('desktop', 'win32'), { onTop: false, level: 'normal', relativeLevel: 0 });
same('normal call', deskWidgetLevelCall('normal', 'darwin'), { onTop: false, level: 'normal', relativeLevel: 0 });
same('floating call', deskWidgetLevelCall('floating', 'win32'), { onTop: true, level: 'floating', relativeLevel: 0 });

// Placement.
const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 2560, height: 1400 };
const platter = DESK_WIDGET_SIZES.platter;
const card = DESK_WIDGET_SIZES.card;

// Never placed: bottom right of the primary work area, clear of the edge.
const first = placeDeskWidget(null, 'platter', [primary, second], primary);
same('never placed', first, { x: 1920 - platter.width - 24, y: 1040 - platter.height - 24, ...platter });

// A saved corner on a connected display is kept as it is.
same('kept on the second display', placeDeskWidget({ x: 2400, y: 300 }, 'card', [primary, second], primary), { x: 2400, y: 300, ...card });

// Hanging off the edge with enough left to grab: pulled fully inside that display.
same(
  'pulled inside',
  placeDeskWidget({ x: 1920 + 2560 - 200, y: 1400 - 100 }, 'platter', [primary, second], primary),
  { x: 1920 + 2560 - platter.width, y: 1400 - platter.height, ...platter },
);

// Only a sliver left on screen counts as lost, the same rule the main window follows.
same(
  'a sliver is not reachable',
  placeDeskWidget({ x: 1920 + 2560 - 100, y: 1400 - 60 }, 'platter', [primary, second], primary),
  { x: 1920 - platter.width - 24, y: 1040 - platter.height - 24, ...platter },
);

// Its monitor is gone: back to the corner of the primary display.
same(
  'display removed',
  placeDeskWidget({ x: 2400, y: 300 }, 'card', [primary], primary),
  { x: 1920 - card.width - 24, y: 1040 - card.height - 24, ...card },
);

// A work area that does not start at the origin (a Dock or taskbar on the left or top).
const inset = { x: 80, y: 30, width: 1840, height: 1010 };
same('inset work area', placeDeskWidget(null, 'platter', [inset], inset), { x: 80 + 1840 - platter.width - 24, y: 30 + 1010 - platter.height - 24, ...platter });

// Settings round trip: the widget's state is a known key, is normalized on the
// way in, and comes back from disk.
const dir = mkdtempSync(join(tmpdir(), 'newamp-desk-widget-'));
try {
  const file = join(dir, 'settings.json');
  const store = new SettingsStore(file);
  same('default in a new profile', store.get().deskWidget, empty);
  store.set({ deskWidget: { open: true, layout: 'card', level: 'floating', origin: { x: 12.2, y: 34.7 }, extra: 'dropped' } });
  same('normalized on set', store.get().deskWidget, { open: true, layout: 'card', level: 'floating', origin: { x: 12, y: 35 } });
  store.flushSync();
  same('on disk', JSON.parse(readFileSync(file, 'utf8')).deskWidget, { open: true, layout: 'card', level: 'floating', origin: { x: 12, y: 35 } });
  same('reopened', new SettingsStore(file).get().deskWidget, { open: true, layout: 'card', level: 'floating', origin: { x: 12, y: 35 } });
  // A patch of something else leaves it alone.
  store.set({ volume: 0.5 });
  same('untouched by another patch', store.get().deskWidget.layout, 'card');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const report = log.join('\n') + '\n' + (pass ? '[desk-widget-test] PASS' : '[desk-widget-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
