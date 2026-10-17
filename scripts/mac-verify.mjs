// Checks what can be checked by script on a Mac: the packaged bundle (signature,
// entitlements, Info.plist, the native audio addon) and the running app's macOS
// behaviour, driven the way cpu-bench.mjs and ui-playlists-smoke.mjs drive it,
// over the DevTools protocol, with the main process reached through --inspect.
//
//   node scripts/mac-verify.mjs                 packaged build in release/ if there is one, else the dev tree
//   node scripts/mac-verify.mjs --app /Applications/NewAmp.app
//   node scripts/mac-verify.mjs --target dev    the built dev tree (needs `npm run build`)
//   node scripts/mac-verify.mjs --only menu,fullscreen    check ids or areas
//   node scripts/mac-verify.mjs --list                    every check and what it covers
//
// The app is started with a throwaway profile (NEWAMP_USER_DATA_DIR), three
// quiet generated tracks and the volume turned down; the person's own settings
// and library are not read. No system audio setting is changed: the exclusive
// output check only asks whether the addon loads and lists devices.
//
// Run it from Terminal in the Mac's own login session. Over plain SSH the app
// may not be able to reach the window server.
//
// Options: --only/--skip <ids or areas>  --json <file>  --out <folder>  --keep
// (leave the throwaway profile)  --screenshots (needs Screen Recording for
// Terminal)  --ui-scripting (real key presses through System Events, needs
// Accessibility)  --mute  --timeout <seconds per check>  --rehearse (run the
// platform-neutral checks on another OS to prove the plumbing; the macOS-only
// ones are skipped).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, sleep, waitForTarget } from './mac/cdp.mjs';
import { FIXTURE_TRACKS, prepareFixtures, resolveFfmpeg, writeSettings } from './mac/fixtures.mjs';
import { addonIdFor, buildCoreAudioHelper, coreAudio, coreAudioDeviceState } from './mac/coreaudio-helper.mjs';
import {
  KEYS,
  clip,
  findTrafficLights,
  formatTable,
  holdsAssertion,
  parseCodesignDetails,
  parseEntitlements,
  parseInterfaceStyle,
  parseLipoArchs,
  parsePmsetAssertions,
  parseSpctl,
  parseVersion,
  readBmp,
  summarize,
  versionAtLeast,
} from './mac/parsers.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : fallback;
};

const isMac = process.platform === 'darwin';
// --rehearse-all also runs the macOS-only checks on another OS. They fail there
// for platform reasons; it exists to shake out script errors before a Mac run.
const rehearse = has('--rehearse') || has('--rehearse-all');
const listOnly = has('--list');

if (has('--help')) {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
if (!isMac && !rehearse && !listOnly) {
  console.log(`[mac-verify] This needs macOS (this machine is ${process.platform}). Nothing was run.`);
  console.log('[mac-verify] Run it on the Mac:  node scripts/mac-verify.mjs');
  process.exit(0);
}

const checks = [];
// platforms: 'darwin' checks only mean something on a Mac; 'any' ones are
// platform-neutral and also run in --rehearse mode on another OS.
function check(id, area, title, fn, { platforms = 'darwin', needs = 'none', timeoutMs, retry = true } = {}) {
  checks.push({ id, area, title, fn, platforms, needs, timeoutMs, retry });
}
const pass = (detail = '', evidence) => ({ status: 'PASS', detail, evidence });
const info = (detail = '', evidence) => ({ status: 'INFO', detail, evidence });
const skip = (detail = '') => ({ status: 'SKIP', detail });
const manual = (detail = '') => ({ status: 'MANUAL', detail });
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const outDir = resolve(opt('--out', join(repoRoot, 'tmp', 'mac-verify')));
const artifactDir = join(outDir, 'artifacts');
const jsonPath = resolve(opt('--json', join(outDir, 'result.json')));
const perCheckMs = Number(opt('--timeout', 90)) * 1000;

function sh(command, args = [], { timeout = 20000, input } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, input, maxBuffer: 16 * 1024 * 1024 });
  return {
    status: result.error ? -1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

function locateTarget() {
  const forced = opt('--target', 'auto');
  const explicit = opt('--app', null);
  // electron-builder writes the Apple Silicon build to release/mac-arm64 and
  // the Intel one to release/mac; take the one this Mac can run natively.
  const builds = process.arch === 'arm64' ? ['mac-arm64'] : ['mac', 'mac-x64'];
  const packagedCandidates = [explicit, ...builds.map((dir) => join(repoRoot, 'release', dir, 'NewAmp.app'))].filter(Boolean);
  const packaged = forced === 'dev' ? null : packagedCandidates.find((p) => existsSync(join(p, 'Contents', 'Info.plist')));
  if (explicit && !packaged) throw new Error(`--app ${explicit} is not an app bundle (no Contents/Info.plist)`);
  if (packaged) {
    const plist = sh('plutil', ['-convert', 'json', '-o', '-', join(packaged, 'Contents', 'Info.plist')]);
    const info = plist.status === 0 ? JSON.parse(plist.stdout) : {};
    const exeName = info.CFBundleExecutable ?? 'NewAmp';
    return { kind: 'packaged', appPath: packaged, exe: join(packaged, 'Contents', 'MacOS', exeName), args: [], cwd: join(packaged, 'Contents', 'MacOS'), plist: info };
  }
  if (forced === 'packaged') throw new Error('No packaged app found. Run `npm run package:mac`, or pass --app <path to NewAmp.app>.');
  const built = existsSync(join(repoRoot, 'dist-electron', 'electron', 'main.js')) && existsSync(join(repoRoot, 'dist', 'index.html'));
  if (!built) throw new Error('Nothing to test: no packaged app in release/ and no build in dist/ + dist-electron/. Run `npm run build` (or `npm run package:mac`).');
  const electronPath = String(createRequire(import.meta.url)('electron'));
  return { kind: 'dev', appPath: null, exe: electronPath, args: ['.'], cwd: repoRoot, plist: null };
}

function bundleAddonPath(target) {
  const platformArch = `${process.platform}-${process.arch}`;
  return target.kind === 'packaged'
    ? join(target.appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'native', 'newamp-audio', 'prebuilt', platformArch, 'newamp_audio.node')
    : join(repoRoot, 'native', 'newamp-audio', 'prebuilt', platformArch, 'newamp_audio.node');
}

const PAGE_HELPERS = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, fn, timeout = 15000) => {
  const start = performance.now();
  while (performance.now() - start < timeout) { const v = fn(); if (v) return v; await sleep(50); }
  throw new Error('timed out waiting for ' + label);
};
const navTo = async (id) => {
  const b = await waitFor('nav ' + id, () => document.querySelector('[data-newamp-nav="' + id + '"]'), 20000);
  b.click();
  await sleep(250);
};
const transport = () => {
  const t = document.querySelector('[data-newamp-transport]');
  if (!t) return null;
  const title = t.querySelector('[data-newamp-current-title]');
  const time = t.querySelector('[data-newamp-current-time]');
  const vol = t.querySelector('.volume-slider-input');
  return {
    playing: t.getAttribute('data-newamp-playing') === 'true',
    title: title ? title.getAttribute('data-newamp-current-title') : '',
    time: time ? Number(time.getAttribute('data-newamp-current-time')) : 0,
    volume: vol ? Number(vol.value) : null,
  };
};
const rowFor = (title) => document.querySelector('[data-newamp-track-row][data-track-title="' + title + '"]');
const playTitle = async (title) => {
  await navTo('library');
  const row = await waitFor('library row ' + title, () => rowFor(title), 40000);
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
  await waitFor('playing ' + title, () => { const t = transport(); return t && t.playing && t.title.includes(title); }, 20000);
};
const setVolume = (v) => {
  const input = document.querySelector('[data-newamp-transport] .volume-slider-input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(v));
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const clickAria = (label) => {
  const b = document.querySelector('[data-newamp-transport] button[aria-label="' + label + '"]');
  if (!b) throw new Error('no transport button ' + label);
  b.click();
};
`;

class AppHandle {
  constructor(target, fixtures, options) {
    this.target = target;
    this.fixtures = fixtures;
    this.options = options;
    this.child = null;
    this.page = null;
    this.main = null;
    this.mainError = null;
    this.exit = null;
    this.stderrTail = [];
    this.consoleLog = [];
    this.launchedAt = 0;
    this.readyMs = 0;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  get alive() {
    return !!this.child && this.exit === null;
  }

  async launch() {
    const randomPort = () => 9500 + Math.floor(Math.random() * 400);
    const cdpPort = randomPort();
    const inspectPort = cdpPort + 400;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, {
      NODE_ENV: 'production',
      NEWAMP_USER_DATA_DIR: this.fixtures.userData,
      NEWAMP_SESSION_DATA_DIR: this.fixtures.sessionData,
      ELECTRON_ENABLE_LOGGING: '1',
    });
    const args = [
      ...this.target.args,
      `--remote-debugging-port=${cdpPort}`,
      `--inspect=127.0.0.1:${inspectPort}`,
      `--newamp-user-data-dir=${this.fixtures.userData}`,
      ...(this.options.mute ? ['--mute-audio'] : []),
    ];
    this.exit = null;
    this.launchedAt = Date.now();
    this.child = spawn(this.target.exe, args, { cwd: this.target.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line) this.stderrTail.push(line);
      if (this.stderrTail.length > 400) this.stderrTail.splice(0, this.stderrTail.length - 400);
    };
    this.child.stderr.on('data', keep);
    this.child.stdout.on('data', keep);
    this.child.once('exit', (code, signal) => {
      this.exit = { code, signal, at: Date.now() };
    });
    this.child.once('error', (err) => {
      this.exit = { code: -1, signal: null, error: String(err), at: Date.now() };
    });

    const exitedEarly = () =>
      this.exit
        ? `the app exited (code ${this.exit.code}, signal ${this.exit.signal}) before its window appeared. Last output: ${clip(this.stderrTail.slice(-8).join(' | '), 400)}`
        : null;
    const pageTarget = await waitForTarget(cdpPort, (t) => t.type === 'page' && /index\.html/.test(t.url), { timeoutMs: 60000, label: 'renderer', abort: exitedEarly });
    this.page = await CdpSession.connect(pageTarget.webSocketDebuggerUrl, 'renderer');
    await this.page.send('Runtime.enable');
    await this.page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
    this.page.on('Runtime.exceptionThrown', (p) => this.consoleLog.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`));
    this.page.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error' || p.type === 'warning') this.consoleLog.push(`${p.type}: ${(p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`);
    });

    this.inspectPort = inspectPort;
    await this.attachMain();

    await this.pageEval(`
      await waitFor('transport', () => document.querySelector('[data-newamp-transport]'), 45000);
      const start = [...document.querySelectorAll('button')].find((b) => /START LISTENING/i.test(b.textContent || ''));
      if (start) start.click();
      await navTo('library');
      await waitFor('fixture tracks in the library', () => document.querySelectorAll('[data-newamp-track-row]').length >= 3, 90000);
      return true;`, { timeoutMs: 150000 });
    this.readyMs = Date.now() - this.launchedAt;
  }

  async attachMain() {
    try {
      const mainTarget = await waitForTarget(this.inspectPort, (t) => !!t.webSocketDebuggerUrl, { timeoutMs: 8000, label: 'main process inspector' });
      this.main = await CdpSession.connect(mainTarget.webSocketDebuggerUrl, 'main');
      this.mainError = null;
      await this.mainEval('return true;');
    } catch (err) {
      this.main = null;
      this.mainError = String(err.message ?? err);
    }
  }

  // Node holds the process open at exit until an attached inspector lets go
  // ("Waiting for the debugger to disconnect"), so every quit starts by
  // detaching it. The Windows rehearsal showed it: after one evaluation the app
  // no longer exits on its own while the session is open.
  detachMain() {
    this.main?.close();
    this.main = null;
    this.mainError = 'detached before quitting';
  }

  pageEval(body, { timeoutMs = 60000 } = {}) {
    if (!this.page) return Promise.reject(new Error('renderer is not connected'));
    return this.page.evaluate(`(async () => { ${PAGE_HELPERS}\n${body} })()`, { timeoutMs });
  }

  mainEval(body, { timeoutMs = 30000 } = {}) {
    if (!this.main) return Promise.reject(new Error(`main-process probe unavailable: ${this.mainError ?? 'not attached'}`));
    const expression = `(async () => {
      const nodeModule = process.getBuiltinModule ? process.getBuiltinModule('node:module') : null;
      const E = (nodeModule ? nodeModule.createRequire(process.execPath) : process.mainModule.require)('electron');
      const { app, BrowserWindow, Menu, screen, globalShortcut, systemPreferences, nativeTheme } = E;
      const mainWindow = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && /index\\.html/.test(w.webContents.getURL())) || null;
      ${body}
    })()`;
    return this.main.evaluate(expression, { timeoutMs });
  }

  windowState() {
    return this.mainEval(`
      const w = mainWindow();
      if (!w) return null;
      const darwin = process.platform === 'darwin';
      return {
        visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused(),
        fullScreen: w.isFullScreen(), simpleFullScreen: darwin ? w.isSimpleFullScreen() : false,
        maximized: w.isMaximized(), bounds: w.getBounds(), resizable: w.isResizable(), movable: w.isMovable(),
        minimizable: w.isMinimizable(), closable: w.isClosable(), fullScreenable: w.isFullScreenable(),
        alwaysOnTop: w.isAlwaysOnTop(), audible: w.webContents.isCurrentlyAudible(), backgroundColor: w.getBackgroundColor(),
        windows: BrowserWindow.getAllWindows().map((x) => ({ id: x.id, visible: x.isVisible(), url: x.webContents.getURL().slice(0, 70) })),
        dockVisible: darwin && app.dock ? app.dock.isVisible() : null,
      };`);
  }

  async waitUntil(label, read, accept, timeoutMs = 10000, pollMs = 120) {
    const started = Date.now();
    let value = await read();
    while (!accept(value) && Date.now() - started < timeoutMs) {
      await sleep(pollMs);
      value = await read();
    }
    if (!accept(value)) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}; last: ${clip(JSON.stringify(value), 220)}`);
    return value;
  }

  descendants() {
    const table = sh('ps', ['-A', '-o', 'pid=,ppid=']).stdout.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((p) => p.length === 2);
    const found = new Set();
    const queue = [this.pid];
    while (queue.length) {
      const parent = queue.pop();
      for (const [pid, ppid] of table) if (ppid === parent && !found.has(pid)) { found.add(pid); queue.push(pid); }
    }
    return [...found];
  }

  closeSessions() {
    this.page?.close();
    this.main?.close();
  }

  async kill() {
    this.closeSessions();
    if (this.alive) {
      // The helper processes are this app's own children; a hard kill of the
      // main process can leave them behind for a moment, so take them too.
      const family = isMac ? this.descendants() : [];
      this.child.kill('SIGKILL');
      for (const pid of family) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await new Promise((resolveExit) => (this.exit ? resolveExit() : this.child.once('exit', resolveExit)));
    }
  }
}

const ctx = { target: null, fixtures: null, app: null, restarts: 0, leftBounds: null, options: { mute: has('--mute') }, results: [], screenshots: has('--screenshots'), uiScripting: has('--ui-scripting') };

// A check that leaves the renderer wedged would fail every check after it, so
// the page is probed first and the app restarted when it does not answer.
async function ensureApp() {
  if (ctx.app?.alive && ctx.app.page && !ctx.app.page.closed) {
    const healthy = await ctx.app.page.evaluate('new Promise((r) => setTimeout(() => r(2), 30))', { timeoutMs: 6000 }).then((v) => v === 2, () => false);
    if (healthy) return ctx.app;
    console.log('\n[mac-verify] the page stopped answering; restarting the app');
    ctx.restarts += 1;
  }
  if (ctx.app) await ctx.app.kill();
  ctx.app = new AppHandle(ctx.target, ctx.fixtures, ctx.options);
  await ctx.app.launch();
  return ctx.app;
}

// Puts the window back where every check expects it: visible, not full screen,
// not a deck, on the Library, nothing playing.
async function reset(app, { keepPlaying = false } = {}) {
  if (app.main) {
    let state = await app.windowState();
    if (state?.fullScreen) {
      await app.mainEval('mainWindow().setFullScreen(false); return true;');
      await app.waitUntil('leave native fullscreen', () => app.windowState(), (s) => !s.fullScreen, 6000);
    }
    // A minimized window also reports isVisible() false, so bring it back first.
    if (state?.minimized) {
      await app.mainEval('mainWindow().restore(); return true;');
      await app.waitUntil('window restored', () => app.windowState(), (s) => !s.minimized, 6000);
    }
    state = await app.windowState();
    if (state && !state.visible) {
      await app.mainEval(`${isMac ? 'app.emit("activate");' : 'mainWindow().show();'} return true;`);
      await app.waitUntil('window visible', () => app.windowState(), (s) => s.visible, 6000);
    }
  }
  // Deck mode lives in the renderer's store; only the deck shortcut (or the
  // deck's own Exit button) leaves it. winctl.setCompact(false) just resizes
  // the window and leaves the deck UI, and every later check then waits for a
  // sidebar that never comes back.
  const inDeck = await app.pageEval(`
    if (window.winctl && window.winctl.isFullscreen && await window.winctl.isFullscreen()) { await window.winctl.setFullscreen(false); await sleep(600); }
    return !document.querySelector('[data-newamp-sidebar]');`);
  if (inDeck) {
    await app.page.pressKey({ ...KEYS.M, meta: true, shift: true });
    const back = await app.pageEval(`
      for (let i = 0; i < 100 && !document.querySelector('[data-newamp-sidebar]'); i += 1) await sleep(50);
      return !!document.querySelector('[data-newamp-sidebar]');`);
    if (!back) await app.pageEval(`await window.winctl.setCompact(false); await sleep(900); return true;`);
  }
  await app.pageEval(`
    ${keepPlaying ? '' : "const t = transport(); if (t && t.playing) clickAria('Pause');"}
    await navTo('library');
    return true;`);
}

async function pmset() {
  const out = sh('pmset', ['-g', 'assertions']);
  return parsePmsetAssertions(out.stdout);
}

function osascript(script, timeout = 12000) {
  return sh('osascript', ['-e', script], { timeout });
}

async function windowCapture(app, name) {
  const id = await app.mainEval(`const w = mainWindow(); return w ? w.getMediaSourceId() : null;`);
  const windowId = /window:(\d+):/.exec(String(id))?.[1];
  if (!windowId) throw new Error('no window id for screencapture');
  mkdirSync(artifactDir, { recursive: true });
  const png = join(artifactDir, `${name}.png`);
  const bmp = join(artifactDir, `${name}.bmp`);
  const shot = sh('screencapture', ['-x', '-o', `-l${windowId}`, png]);
  if (shot.status !== 0 || !existsSync(png)) throw new Error(`screencapture failed: ${shot.stderr || shot.error || shot.status}`);
  const convert = sh('sips', ['-s', 'format', 'bmp', png, '--out', bmp]);
  if (convert.status !== 0) throw new Error(`sips failed: ${convert.stderr}`);
  return { png, image: readBmp(readFileSync(bmp)) };
}

const trackByCodec = (codec) => FIXTURE_TRACKS.find((t) => t.codec === codec);

// ---------------------------------------------------------------- bundle checks

check('host', 'host', 'Mac, macOS version, Node and Xcode tools', async () => {
  const product = isMac ? sh('sw_vers', ['-productVersion']).stdout.trim() : release();
  const nodeOk = versionAtLeast(parseVersion(process.version) ?? [0, 0, 0], parseVersion(pkg.engines.node) ?? [0, 0, 0]);
  expect(nodeOk, `Node ${process.version} is older than the ${pkg.engines.node} the repo needs`);
  const clt = isMac ? sh('xcode-select', ['-p']) : { status: 1, stdout: '' };
  const machine = isMac ? sh('sysctl', ['-n', 'hw.model']).stdout.trim() : '';
  return info(`macOS ${product} ${arch()} ${machine}, Node ${process.version}, ${Math.round(totalmem() / 2 ** 30)} GB RAM, Xcode tools ${clt.status === 0 ? clt.stdout.trim() : 'not installed'}`, {
    product, arch: arch(), machine, node: process.version, xcodeTools: clt.status === 0 ? clt.stdout.trim() : null,
  });
});

check('bundle-info', 'bundle', 'Info.plist: bundle id, version, architecture, document types', async () => {
  const t = ctx.target;
  if (t.kind !== 'packaged') return skip('testing the dev tree, there is no bundle');
  const plist = t.plist;
  expect(plist.CFBundleIdentifier === 'io.newamp.player', `bundle id is ${plist.CFBundleIdentifier}`);
  expect(plist.CFBundleShortVersionString === pkg.version, `bundle version ${plist.CFBundleShortVersionString} differs from package.json ${pkg.version}`);
  const archs = parseLipoArchs(sh('lipo', ['-archs', t.exe]).stdout);
  expect(archs.includes(process.arch === 'arm64' ? 'arm64' : 'x86_64'), `main binary is ${archs.join('+')}, this Mac is ${process.arch}`);
  const docTypes = (plist.CFBundleDocumentTypes ?? []).length;
  expect(docTypes >= 2, `only ${docTypes} document type(s) declared; audio and playlist files should both be there`);
  return pass(`${plist.CFBundleName} ${plist.CFBundleShortVersionString}, ${archs.join('+')}, min macOS ${plist.LSMinimumSystemVersion ?? 'unset'}, ${docTypes} document types`, {
    highResolution: plist.NSHighResolutionCapable, category: plist.LSApplicationCategoryType,
  });
});

check('codesign', 'bundle', 'Code signature is sealed and the hardened runtime is on', async () => {
  const t = ctx.target;
  if (t.kind !== 'packaged') return skip('dev tree is not a signed bundle');
  const verify = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', t.appPath], { timeout: 120000 });
  expect(verify.status === 0, `codesign --verify failed: ${clip(verify.stderr, 300)}`);
  const details = parseCodesignDetails(sh('codesign', ['-dv', '--verbose=4', t.appPath]).stderr);
  expect(details.hardenedRuntime, `hardened runtime flag missing (${details.flags})`);
  const kind = details.developerId ? `Developer ID (${details.teamId})` : details.adhoc ? 'ad-hoc' : 'other';
  return pass(`sealed, ${kind}, flags ${details.flags}, identifier ${details.identifier}`, details);
});

check('entitlements', 'bundle', 'Entitlements: JIT, unsigned memory, library validation off', async () => {
  const t = ctx.target;
  if (t.kind !== 'packaged') return skip('dev tree is not a signed bundle');
  const out = sh('codesign', ['-d', '--entitlements', ':-', t.appPath]);
  const entitlements = parseEntitlements(out.stdout);
  const want = ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.cs.disable-library-validation'];
  const missing = want.filter((key) => entitlements[key] !== true);
  expect(missing.length === 0, `missing entitlements: ${missing.join(', ')}`);
  return pass('all three present', entitlements);
});

check('gatekeeper', 'bundle', 'Gatekeeper verdict and quarantine state', async () => {
  const t = ctx.target;
  if (t.kind !== 'packaged') return skip('dev tree is not a signed bundle');
  const details = parseCodesignDetails(sh('codesign', ['-dv', '--verbose=4', t.appPath]).stderr);
  const assess = sh('spctl', ['--assess', '--type', 'execute', '--verbose=4', t.appPath]);
  const verdict = parseSpctl(`${assess.stdout}${assess.stderr}`, assess.status);
  const stapled = sh('xcrun', ['stapler', 'validate', t.appPath]);
  const quarantine = sh('xattr', ['-p', 'com.apple.quarantine', t.appPath]);
  const evidence = { verdict, stapled: stapled.status === 0, quarantine: quarantine.status === 0 ? quarantine.stdout.trim() : null, signature: details.signature };
  if (verdict.accepted) return pass(`accepted${verdict.notarized ? ', notarized' : ''}${evidence.quarantine ? ', quarantined' : ''}`, evidence);
  if (details.developerId) throw new Error(`Developer ID signed but Gatekeeper rejects it: ${clip(verdict.raw, 200)}`);
  return info(`rejected, as expected for ${details.adhoc ? 'an ad-hoc signature' : 'an unsigned build'}. First launch needs System Settings > Privacy & Security > Open Anyway (MAC-PLAN section 6.1)`, evidence);
});

check('native-addon-file', 'audio', 'Native audio addon is in the build, signed and the right architecture', async () => {
  const addon = bundleAddonPath(ctx.target);
  expect(existsSync(addon), `addon missing: ${addon}${ctx.target.kind === 'dev' ? '  (npm run build:native)' : ''}`);
  const archs = parseLipoArchs(sh('lipo', ['-archs', addon]).stdout);
  const want = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  expect(archs.includes(want), `addon is ${archs.join('+') || 'not Mach-O'}, this Mac is ${want}`);
  const sig = sh('codesign', ['-dv', '--verbose=2', addon]);
  const signed = sig.status === 0;
  return pass(`${archs.join('+')}, ${signed ? 'code-signed' : 'not signed (fine for a dev build, a problem inside a hardened bundle with library validation on)'}`, { addon });
}, { platforms: 'darwin' });

check('addon-load', 'audio', 'Addon loads and lists output devices (read-only)', async () => {
  const addon = bundleAddonPath(ctx.target);
  expect(existsSync(addon), 'addon missing');
  const script = `
    const addon = require(${JSON.stringify(addon)});
    const devices = addon.listDevices();
    const def = devices.find((d) => d.isDefault) || devices[0];
    const probe = def ? addon.probeDevice(def.id) : null;
    process.stdout.write(JSON.stringify({ devices, probe }));`;
  const run = sh(process.execPath, ['-e', script], { timeout: 30000 });
  expect(run.status === 0, `loading the addon in Node failed (${run.status}): ${clip(run.stderr, 300)}`);
  const parsed = JSON.parse(run.stdout);
  expect(parsed.devices.length > 0, 'the addon sees no output devices');
  const formats = parsed.probe?.formats ?? [];
  const rates = [...new Set(formats.map((f) => f.sampleRate))].sort((a, b) => a - b);
  return pass(`${parsed.devices.length} device(s), default "${parsed.devices.find((d) => d.isDefault)?.name ?? '?'}", probe lists ${formats.length} formats, rates ${rates.join('/')}`, parsed);
}, { platforms: 'any' });

check('ffmpeg-bundled', 'audio', 'Bundled ffmpeg runs and can decode Apple Lossless', async () => {
  const bundled = ctx.target.kind === 'packaged'
    ? join(ctx.target.appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg')
    : resolveFfmpeg({ repoRoot, appPath: null });
  expect(bundled && (bundled === 'ffmpeg' || existsSync(bundled)), `no ffmpeg at ${bundled}`);
  const version = sh(bundled, ['-version']);
  expect(version.status === 0, `ffmpeg -version exited ${version.status}: ${clip(version.stderr, 200)}`);
  const decoders = sh(bundled, ['-hide_banner', '-decoders']).stdout;
  expect(/\balac\b/.test(decoders), 'this ffmpeg has no alac decoder');
  const archs = parseLipoArchs(sh('lipo', ['-archs', bundled]).stdout);
  const soxr = /--enable-libsoxr/.test(sh(bundled, ['-hide_banner', '-buildconf']).stdout);
  return pass(`${clip(version.stdout.split('\n')[0], 60)}, ${archs.join('+')}, soxr ${soxr ? 'yes' : 'no (swr fallback)'}`);
}, { platforms: 'any' });

// ---------------------------------------------------------------- running app

check('launch', 'app', 'App launches with a throwaway profile; renderer and main-process probe attach', async () => {
  const app = await ensureApp();
  const state = app.main ? await app.windowState() : null;
  expect(app.alive, 'app exited right after launch');
  const parts = [`ready in ${(app.readyMs / 1000).toFixed(1)} s`, app.main ? 'main probe attached' : `main probe NOT attached (${app.mainError})`];
  if (state) parts.push(`window ${state.bounds.width}x${state.bounds.height} at ${state.bounds.x},${state.bounds.y}`);
  return pass(parts.join(', '), { state, mainError: app.mainError });
}, { platforms: 'any', needs: 'app', timeoutMs: 240000, retry: false });

check('exclusive-in-app', 'audio', 'Exclusive output reports available inside the app (no device is opened)', async () => {
  const app = await ensureApp();
  const result = await app.pageEval(`
    const supported = await window.newamp.exclusiveSupported();
    const devices = supported ? await window.newamp.exclusiveListDevices() : [];
    return { supported, devices };`);
  expect(result.supported === true, 'exclusiveSupported() is false: the addon did not load inside the app (a hardened-runtime or architecture problem; see the stderr tail in the JSON)');
  expect(result.devices.length > 0, 'supported, but no devices listed');
  return pass(`supported, ${result.devices.length} device(s): ${result.devices.map((d) => d.name).join(', ')}`, result);
}, { platforms: 'any', needs: 'app' });

check('formats-play', 'playback', 'MP3, FLAC and Apple Lossless (.m4a) all play; ALAC is badged', async () => {
  const app = await ensureApp();
  await reset(app);
  const rows = [];
  for (const track of FIXTURE_TRACKS) {
    const seen = await app.pageEval(`
      await playTitle(${JSON.stringify(track.title)});
      const first = transport();
      await sleep(2600);
      const later = transport();
      const row = rowFor(${JSON.stringify(track.title)});
      const badges = row ? row.querySelector('[data-newamp-format-badges]') : null;
      return { advanced: later.time - first.time, playing: later.playing, rowText: ((badges ? badges.textContent : '') + ' ' + (row ? row.textContent : '')).slice(0, 200) };`);
    let audible = null;
    if (app.main && !ctx.options.mute) {
      audible = (await app.waitUntil('audible output', () => app.windowState(), (s) => s.audible, 7000).catch(() => null))?.audible ?? false;
    }
    rows.push({ codec: track.codec, ...seen, audible });
    expect(seen.playing && seen.advanced > 1.5, `${track.codec}: the clock moved ${seen.advanced.toFixed(2)} s in 2.6 s`);
    if (audible === false) throw new Error(`${track.codec}: the clock moves but Chromium reports no audible output (no output device attached, or muted? --mute skips this signal)`);
    if (track.codec === 'alac') expect(/ALAC/i.test(seen.rowText), `the ALAC file's row shows no ALAC badge: "${clip(seen.rowText, 90)}"`);
  }
  await app.pageEval(`clickAria('Pause'); return true;`);
  return pass(rows.map((r) => `${r.codec} +${r.advanced.toFixed(1)}s${r.audible === null ? '' : r.audible ? ' audible' : ''}`).join(', '), rows);
}, { platforms: 'any', needs: 'app' });

check('media-session', 'now-playing', 'MediaSession carries title, artist, album and state (feeds Now Playing)', async () => {
  const app = await ensureApp();
  await reset(app);
  const track = trackByCodec('mp3');
  const data = await app.pageEval(`
    await playTitle(${JSON.stringify(track.title)});
    await sleep(1200);
    const s = navigator.mediaSession;
    const m = s.metadata;
    const playing = { state: s.playbackState, title: m && m.title, artist: m && m.artist, album: m && m.album, artwork: m ? m.artwork.map((a) => a.src).slice(0, 2) : [] };
    clickAria('Pause');
    await sleep(900);
    return { playing, pausedState: s.playbackState };`);
  expect(data.playing.title === track.title, `metadata title is "${data.playing.title}", wanted "${track.title}"`);
  expect(data.playing.artist === 'Mac Verify' && data.playing.album === 'Fixture Album', `artist/album are "${data.playing.artist}" / "${data.playing.album}"`);
  expect(data.playing.state === 'playing', `playbackState while playing is "${data.playing.state}"`);
  expect(data.pausedState === 'paused', `playbackState after pause is "${data.pausedState}"`);
  const extra = [];
  if (isMac) {
    const cli = sh('which', ['nowplaying-cli']);
    if (cli.status === 0) extra.push(`nowplaying-cli (system view): ${clip(sh('nowplaying-cli', ['get', 'title', 'artist']).stdout, 80) || 'nothing reported'}`);
    if (app.main) {
      const keys = await app.mainEval(`return { play: globalShortcut.isRegistered('MediaPlayPause'), next: globalShortcut.isRegistered('MediaNextTrack'), trusted: systemPreferences.isTrustedAccessibilityClient(false) };`);
      extra.push(`global media keys registered: play ${keys.play}, next ${keys.next}; Accessibility trusted: ${keys.trusted}`);
    }
  }
  return pass(`playing -> "${data.playing.state}", paused -> "${data.pausedState}", artwork ${data.playing.artwork.length ? 'set' : 'none'}. The Control Center tile itself is a manual check. ${extra.join(' | ')}`, { ...data, extra });
}, { platforms: 'any', needs: 'app' });

check('media-session-artwork', 'now-playing', 'MediaSession artwork uses a scheme the system tile can load (http, https, data or blob)', async () => {
  const app = await ensureApp();
  await reset(app);
  const track = trackByCodec('mp3');
  const data = await app.pageEval(`
    await playTitle(${JSON.stringify(track.title)});
    await sleep(1200);
    const m = navigator.mediaSession.metadata;
    clickAria('Pause');
    return { artwork: m ? m.artwork.map((a) => a.src) : [] };`);
  if (!data.artwork.length) return skip('the fixture track has no cover art in this run, so there is nothing to load');
  const unsupported = data.artwork.filter((src) => !/^(https?|data|blob):/i.test(src));
  const warned = app.consoleLog.filter((line) => /MediaImage src can only be/.test(line));
  expect(
    unsupported.length === 0 && warned.length === 0,
    `Chromium drops artwork that is not http, https, data or blob, so Control Center and the system media tile show no cover. Got ${unsupported.join(', ') || 'supported URLs'}${warned.length ? `; console: ${clip(warned[0], 120)}` : ''}`,
  );
  return pass(`artwork URLs are ${data.artwork.map((src) => src.split(':')[0]).join(', ')}`);
}, { platforms: 'any', needs: 'app' });

// ---------------------------------------------------------------- menus and Dock

check('menu-structure', 'menu', 'Application menu: Settings (Cmd+,), About, Hide, Quit (Cmd+Q), Edit, View, Window, Help', async () => {
  const app = await ensureApp();
  expect(app.main, `needs the main-process probe (${app.mainError})`);
  const menu = await app.mainEval(`
    const m = Menu.getApplicationMenu();
    if (!m) return null;
    const walk = (items) => items.map((i) => ({ label: i.label, role: i.role || null, accelerator: i.accelerator ? String(i.accelerator) : null, type: i.type, enabled: i.enabled, submenu: i.submenu ? walk(i.submenu.items) : null }));
    return walk(m.items);`);
  expect(menu, 'there is no application menu');
  const top = menu.map((i) => i.label);
  const flat = (items) => items.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu) : [])]);
  const all = flat(menu);
  const settings = all.find((i) => /^Settings/.test(i.label ?? ''));
  expect(settings, `no Settings item. Top-level menus: ${top.join(', ')}`);
  expect(/^(CmdOrCtrl|CommandOrControl|Cmd|Command)\+,$/.test(settings.accelerator ?? ''), `Settings accelerator is "${settings.accelerator}", wanted Cmd+,`);
  const quit = all.find((i) => i.role === 'quit');
  expect(quit, 'no Quit item (role quit)');
  // Electron gives the role its Cmd+Q default; if the JS object does not expose it, the quit check below still exercises the real path.
  expect(!quit.accelerator || /Q$/i.test(quit.accelerator), `Quit has the accelerator ${quit.accelerator}, wanted Cmd+Q`);
  const roles = new Set(all.map((i) => i.role).filter(Boolean));
  const missing = ['about', 'hide', 'hideOthers', 'unhide', 'services', 'copy', 'paste', 'minimize', 'zoom', 'togglefullscreen'].filter((r) => !roles.has(r.toLowerCase()) && !roles.has(r));
  expect(missing.length === 0, `menu roles missing: ${missing.join(', ')}`);
  const packagedExtras = ['reload', 'forcereload', 'toggledevtools'].filter((r) => roles.has(r));
  if (ctx.target.kind === 'packaged') {
    expect(packagedExtras.length === 0, `a shipped build should not carry ${packagedExtras.join(', ')}`);
    // The About/Hide/Quit labels come from app.getName(), which is the
    // package.json name unless something sets it; "Quit newamp" would be wrong.
    const named = all.filter((i) => ['about', 'hide', 'quit'].includes(i.role));
    const wrong = named.filter((i) => !/NewAmp/.test(i.label ?? ''));
    expect(wrong.length === 0, `menu labels do not say NewAmp: ${wrong.map((i) => `"${i.label}"`).join(', ')}`);
  }
  const appName = await app.mainEval('return { name: app.getName(), packaged: app.isPackaged, version: app.getVersion(), electron: process.versions.electron };');
  return pass(`menus: ${top.join(' | ')}; Settings is ${settings.accelerator}, Quit ${quit.accelerator ?? 'role default'}; app.getName() is "${appName.name}"`, { menu, appName });
}, { needs: 'main' });

check('menu-close-window', 'menu', 'Some menu item closes the window with Cmd+W', async () => {
  const app = await ensureApp();
  expect(app.main, `needs the main-process probe (${app.mainError})`);
  const found = await app.mainEval(`
    const m = Menu.getApplicationMenu();
    const out = [];
    const walk = (items, path) => { for (const i of items) { if (i.submenu) walk(i.submenu.items, path.concat(i.label)); else if (i.role === 'close' || /^(CmdOrCtrl|CommandOrControl|Cmd|Command)\\+W$/i.test(i.accelerator ? String(i.accelerator) : '')) out.push({ path: path.join(' > '), label: i.label, role: i.role, accelerator: i.accelerator ? String(i.accelerator) : null }); } };
    if (m) walk(m.items, []);
    return out;`);
  expect(found.length > 0, 'No menu item has role "close" or the Cmd+W accelerator. On a Mac Cmd+W should close the window (here: hide it, playback goes on). The Window menu role does not include Close on macOS and the template has no File menu.');
  return pass(`${found.map((f) => `${f.path} > ${f.label} (${f.accelerator})`).join('; ')}`, found);
}, { needs: 'main' });

check('menu-settings-opens', 'menu', 'Settings menu item raises a hidden window and opens Settings', async () => {
  const app = await ensureApp();
  expect(app.main, `needs the main-process probe (${app.mainError})`);
  await reset(app);
  await app.mainEval('mainWindow().hide(); return true;');
  await app.waitUntil('window hidden', () => app.windowState(), (s) => !s.visible, 5000);
  await app.mainEval(`
    const find = (items) => { for (const i of items) { if (/^Settings/.test(i.label || '')) return i; if (i.submenu) { const f = find(i.submenu.items); if (f) return f; } } return null; };
    if (!Menu.getApplicationMenu()) throw new Error('there is no application menu');
    const item = find(Menu.getApplicationMenu().items);
    if (!item) throw new Error('no Settings item');
    item.click();
    return true;`);
  await app.waitUntil('window visible again', () => app.windowState(), (s) => s.visible, 6000);
  await app.pageEval(`await waitFor('Settings view', () => document.querySelector('#settings-about'), 10000); return true;`);
  const real = [];
  if (ctx.uiScripting) {
    await reset(app);
    osascript(`tell application "System Events" to set frontmost of (first process whose unix id is ${app.pid}) to true`);
    await sleep(600);
    const sent = osascript('tell application "System Events" to keystroke "," using command down');
    if (sent.status !== 0) real.push(`real Cmd+, not sent: ${clip(sent.stderr, 120)}`);
    else {
      const opened = await app.pageEval(`try { await waitFor('Settings view', () => document.querySelector('#settings-about'), 4000); return true; } catch { return false; }`);
      real.push(opened ? 'real Cmd+, opened Settings' : 'real Cmd+, did NOT open Settings');
      expect(opened, 'the real Cmd+, keystroke did not open Settings');
    }
  }
  await app.pageEval(`await navTo('library'); return true;`);
  return pass(`menu click restored the hidden window and opened Settings${real.length ? `; ${real.join('; ')}` : '; real keystroke not tried (--ui-scripting)'}`);
}, { needs: 'main' });

check('dock-menu', 'dock', 'Dock menu: Previous, Play/Pause (label follows state), Next, Stop all work', async () => {
  const app = await ensureApp();
  expect(app.main, `needs the main-process probe (${app.mainError})`);
  await reset(app);
  const labels = () => app.mainEval(`const m = app.dock && app.dock.getMenu(); return m ? m.items.map((i) => i.label) : null;`);
  const clickDock = (label) => app.mainEval(`const m = app.dock.getMenu(); const i = m.items.find((x) => x.label === ${JSON.stringify(label)}); if (!i) throw new Error('no Dock item ${label}'); i.click(); return true;`);
  const first = await labels();
  expect(first, 'there is no Dock menu');
  for (const want of ['Previous', 'Next', 'Stop']) expect(first.includes(want), `Dock menu has ${JSON.stringify(first)}, no ${want}`);
  expect(first.includes('Play'), `while paused the toggle should read Play: ${JSON.stringify(first)}`);
  await app.pageEval(`await playTitle(${JSON.stringify(trackByCodec('mp3').title)}); return true;`);
  const playing = await app.waitUntil('Dock label to flip to Pause', labels, (l) => !!l && l.includes('Pause'), 6000);
  await clickDock('Next');
  const nextTitle = await app.pageEval(`await waitFor('next track', () => transport().title.includes(${JSON.stringify(trackByCodec('flac').title)}), 8000); return transport().title;`);
  await clickDock('Pause');
  await app.pageEval(`await waitFor('paused', () => !transport().playing, 6000); return true;`);
  const paused = await app.waitUntil('Dock label back to Play', labels, (l) => !!l && l.includes('Play'), 6000);
  await clickDock('Stop');
  return pass(`items ${JSON.stringify(first)}; playing -> ${JSON.stringify(playing)}; Next went to "${nextTitle}"; Pause paused; label back to Play (${paused.join('/')})`);
}, { needs: 'main' });

// ---------------------------------------------------------------- keyboard and wheel

check('shortcuts-cmd', 'keyboard', 'Cmd+Left/Right skip, Cmd+Up/Down change volume, Ctrl+Left/Right still skip, Space toggles', async () => {
  const app = await ensureApp();
  await reset(app);
  const page = app.page;
  const one = trackByCodec('mp3').title;
  const two = trackByCodec('flac').title;
  const read = () => app.pageEval('return transport();');
  await app.pageEval(`await playTitle(${JSON.stringify(one)}); setVolume(0.05); await sleep(300); return true;`);
  await page.pressKey({ ...KEYS.ArrowRight, meta: true });
  await app.waitUntil('Cmd+Right to go to the next track', read, (t) => t.title.includes(two), 6000);
  // Let the second track get going first: Previous restarts a track that has
  // played for a while instead of going back, so the test stays well inside
  // the first few seconds.
  await sleep(1200);
  await page.pressKey({ ...KEYS.ArrowLeft, meta: true });
  await app.waitUntil('Cmd+Left to go back to the first track', read, (t) => t.title.includes(one), 6000);
  await page.pressKey({ ...KEYS.ArrowRight, ctrl: true });
  await app.waitUntil('Ctrl+Right to skip', read, (t) => t.title.includes(two), 6000);
  const v0 = (await read()).volume;
  await page.pressKey({ ...KEYS.ArrowUp, meta: true });
  const up = await app.waitUntil('Cmd+Up to raise the volume', read, (t) => t.volume > v0 + 0.03, 4000);
  await page.pressKey({ ...KEYS.ArrowDown, meta: true });
  const down = await app.waitUntil('Cmd+Down to lower the volume', read, (t) => t.volume < up.volume - 0.03, 4000);
  expect(Math.abs(up.volume - v0 - 0.05) < 0.012, `Cmd+Up moved the volume by ${(up.volume - v0).toFixed(3)}, wanted 0.05`);
  expect(Math.abs(down.volume - v0) < 0.012, `Cmd+Down did not come back to ${v0} (${down.volume})`);
  // Space is the one shortcut that yields to a focused control (a Library
  // row keeps it after a double-click), so clear focus first; what is under
  // test is the binding, not where focus happened to land.
  await app.pageEval('if (document.activeElement) document.activeElement.blur(); return true;');
  await page.pressKey({ ...KEYS.Space });
  await app.waitUntil('Space to pause', read, (t) => !t.playing, 4000);
  await page.pressKey({ ...KEYS.Space });
  await app.waitUntil('Space to resume', read, (t) => t.playing, 4000);
  await page.pressKey({ ...KEYS.F, meta: true });
  const focused = await app.pageEval(`await sleep(250); const a = document.activeElement; return { tag: a && a.tagName, inSearch: !!(a && a.closest && a.closest('[data-newamp-library-search-command]')) };`);
  expect(focused.inSearch, `Cmd+F left focus on <${focused.tag}>, not the Library search`);
  await app.pageEval(`document.activeElement && document.activeElement.blur(); clickAria('Pause'); return true;`);
  return pass(`Cmd+Right/Left, Ctrl+Right, Cmd+Up +${(up.volume - v0).toFixed(2)}, Cmd+Down, Space, Cmd+F all behave. These are synthetic key events; real key presses go through the menu first and need the manual pass.`);
}, { needs: 'app' });

check('wheel-volume', 'volume', 'Wheel over the volume slider: single click, burst, clamp at 100%, Shift+wheel on the horizontal axis', async () => {
  const app = await ensureApp();
  await reset(app);
  const page = app.page;
  const slider = await app.pageEval(`
    const el = await waitFor('volume slider', () => document.querySelector('[data-newamp-transport] .volume-slider-input'), 15000);
    setVolume(0.3);
    await sleep(400);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  const volume = () => app.pageEval('return transport().volume;');
  const burst = async (delta, count, extra = {}) => {
    for (let i = 0; i < count; i += 1) {
      await page.wheel(slider.x, slider.y, extra.deltaX ?? 0, extra.deltaX ? 0 : delta, extra.modifiers ?? 0);
      await sleep(4);
    }
    await sleep(500);
    return volume();
  };
  await page.moveMouse(slider.x, slider.y);
  await sleep(200);
  const start = await volume();
  await page.wheel(slider.x, slider.y, 0, 25);
  await sleep(500);
  const afterOne = await volume();
  expect(Math.abs(afterOne - start) >= 0.019, `a slow wheel click moved the volume by ${(afterOne - start).toFixed(3)}, wanted at least 0.02`);
  const raise = afterOne > start ? 25 : -25;
  const tolerance = 0.03;
  const up = await burst(raise, 40);
  expect(Math.abs(up - (afterOne + 0.4 + 0.01)) <= tolerance, `burst of 40 up: ${afterOne.toFixed(2)} -> ${up.toFixed(2)}, wanted about ${(afterOne + 0.41).toFixed(2)}`);
  const down = await burst(-raise, 40);
  expect(Math.abs(down - (up - 0.41)) <= tolerance, `burst of 40 down: ${up.toFixed(2)} -> ${down.toFixed(2)}, wanted about ${(up - 0.41).toFixed(2)}`);
  await app.pageEval('setVolume(0.95); await sleep(300); return true;');
  const clamped = await burst(raise, 20);
  expect(Math.abs(clamped - 1) < 1e-6, `a burst past 100% ended at ${clamped}, wanted exactly 1`);
  await app.pageEval('setVolume(0.5); await sleep(300); return true;');
  const before = await volume();
  const shifted = await burst(0, 8, { deltaX: 25, modifiers: 8 });
  expect(Math.abs(shifted - before) >= 0.019, `Shift+wheel on the horizontal axis changed the volume by ${(shifted - before).toFixed(3)}; macOS sends Shift+wheel as deltaX`);
  await app.pageEval('setVolume(0.05); return true;');
  return pass(`one click ${(afterOne - start).toFixed(2)}, burst +${(up - afterOne).toFixed(2)} / ${(down - up).toFixed(2)}, clamp ${clamped}, Shift+wheel ${(shifted - before).toFixed(2)}. Synthetic wheel events only; trackpad and Magic Mouse feel is a manual check.`);
}, { platforms: 'any', needs: 'app' });

// ---------------------------------------------------------------- window lifecycle

check('close-hides', 'lifecycle', 'Closing the window hides it, playback keeps going, the app stays running', async () => {
  const app = await ensureApp();
  expect(app.main, `needs the main-process probe (${app.mainError})`);
  await reset(app);
  await app.pageEval(`await playTitle(${JSON.stringify(trackByCodec('mp3').title)}); return true;`);
  const before = await app.pageEval('return { time: transport().time, origin: performance.timeOrigin };');
  await app.pageEval('await window.winctl.close(); return true;');
  const hidden = await app.waitUntil('window hidden', () => app.windowState(), (s) => !s.visible, 5000);
  expect(app.alive, 'the app exited when its window was closed');
  expect(hidden.dockVisible !== false, 'the Dock icon disappeared');
  await sleep(3000);
  const after = await app.pageEval('return { time: transport().time, playing: transport().playing, origin: performance.timeOrigin };');
  const audible = (await app.windowState()).audible;
  expect(after.origin === before.origin, 'the renderer was reloaded');
  // A hidden page may throttle its on-screen clock; sound still coming out is
  // the stronger sign that playback carried on.
  const advanced = after.time - before.time > 2;
  expect(after.playing, 'the transport says playback stopped when the window was hidden');
  if (ctx.options.mute) expect(advanced, `playback clock stalled while hidden (${before.time.toFixed(1)} -> ${after.time.toFixed(1)})`);
  else expect(audible || advanced, `hidden window: no audible output and the clock did not move (${before.time.toFixed(1)} -> ${after.time.toFixed(1)})`);
  return pass(`hidden, still running; clock +${(after.time - before.time).toFixed(1)} s in 3 s, audible ${audible}, ${hidden.windows.length} window(s) alive, Dock icon ${hidden.dockVisible}`);
}, { needs: 'main' });

check('activate-restores', 'lifecycle', 'Dock click (reopen) brings the same window back with playback intact', async () => {
  const app = await ensureApp();
  expect(app.main, `needs the main-process probe (${app.mainError})`);
  const before = await app.pageEval('return { time: transport().time, title: transport().title, origin: performance.timeOrigin };');
  let via = 'app.emit(activate)';
  const state0 = await app.windowState();
  expect(!state0.visible, 'the window should still be hidden from the previous check');
  if (ctx.target.kind === 'packaged') {
    sh('open', ['-a', ctx.target.appPath]);
    const reopened = await app.waitUntil('reopen event to show the window', () => app.windowState(), (s) => s.visible, 5000).catch(() => null);
    via = reopened ? 'open -a (a real reopen Apple event)' : 'open -a did not bring it back; fell back to app.emit(activate)';
    if (!reopened) await app.mainEval('app.emit("activate"); return true;');
  } else {
    await app.mainEval('app.emit("activate"); return true;');
  }
  const shown = await app.waitUntil('window visible', () => app.windowState(), (s) => s.visible, 6000);
  const after = await app.pageEval('return { time: transport().time, title: transport().title, playing: transport().playing, origin: performance.timeOrigin };');
  expect(after.origin === before.origin, 'the renderer was reloaded instead of the window being shown again');
  expect(after.title === before.title && after.playing, `playback changed across the hide/show (${before.title} -> ${after.title}, playing ${after.playing})`);
  expect(!via.startsWith('open -a did not'), via);
  return pass(`${via}; window back at ${shown.bounds.width}x${shown.bounds.height}; clock ${before.time.toFixed(1)} -> ${after.time.toFixed(1)}`);
}, { needs: 'main' });

check('open-file', 'lifecycle', 'Opening an audio file from Finder (open -a) plays it in the running app', async () => {
  const app = await ensureApp();
  if (ctx.target.kind !== 'packaged') return skip('open -a needs the packaged app');
  await reset(app);
  const file = join(ctx.fixtures.mediaDir, FIXTURE_TRACKS[1].file);
  await app.mainEval('mainWindow().hide(); return true;');
  const sent = sh('open', ['-a', ctx.target.appPath, file]);
  expect(sent.status === 0, `open -a failed: ${sent.stderr}`);
  const title = await app.pageEval(`await waitFor('opened file to play', () => { const t = transport(); return t.playing && t.title.includes(${JSON.stringify(FIXTURE_TRACKS[1].title)}); }, 12000); return transport().title;`);
  const state = await app.waitUntil('window shown', () => app.windowState(), (s) => s.visible, 6000);
  return pass(`"${title}" is playing; the hidden window came forward (${state.visible})`);
}, { needs: 'main' });

check('fullscreen-simple', 'fullscreen', 'Visualizer fullscreen is in place (no new Space), keeps the display awake, and restores', async () => {
  const app = await ensureApp();
  expect(app.main, `needs the main-process probe (${app.mainError})`);
  await reset(app);
  await app.pageEval(`await playTitle(${JSON.stringify(trackByCodec('mp3').title)}); return true;`);
  const normal = await app.windowState();
  await app.pageEval('await window.winctl.setFullscreen(true); await sleep(900); return true;');
  const full = await app.waitUntil('simple fullscreen', () => app.windowState(), (s) => s.simpleFullScreen, 5000);
  expect(!full.fullScreen, 'the window went into native fullscreen (a new Space) instead of simple fullscreen');
  const display = await app.mainEval('const d = screen.getDisplayMatching(mainWindow().getBounds()); return d.bounds;');
  expect(full.bounds.width >= display.width - 2 && full.bounds.height >= display.height - 2, `fullscreen bounds ${full.bounds.width}x${full.bounds.height} do not cover the ${display.width}x${display.height} display`);
  await sleep(600);
  const awake = holdsAssertion(await pmset(), app.pid, 'PreventUserIdleDisplaySleep');
  expect(awake, 'no PreventUserIdleDisplaySleep assertion from the app while the visualizer is fullscreen and music plays (pmset -g assertions)');
  await app.pageEval('await window.winctl.setFullscreen(false); await sleep(900); return true;');
  const back = await app.waitUntil('leave fullscreen', () => app.windowState(), (s) => !s.simpleFullScreen && !s.fullScreen, 5000);
  await sleep(600);
  const released = !holdsAssertion(await pmset(), app.pid, 'PreventUserIdleDisplaySleep');
  expect(released, 'the display-sleep assertion is still held after leaving fullscreen');
  const drift = Math.abs(back.bounds.x - normal.bounds.x) + Math.abs(back.bounds.y - normal.bounds.y) + Math.abs(back.bounds.width - normal.bounds.width) + Math.abs(back.bounds.height - normal.bounds.height);
  expect(drift <= 8, `window did not return to its size and place (${JSON.stringify(normal.bounds)} -> ${JSON.stringify(back.bounds)})`);
  await app.pageEval(`clickAria('Pause'); return true;`);
  return pass(`simple fullscreen over ${display.width}x${display.height}, no new Space, display-sleep assertion held then released, window restored`);
}, { needs: 'main' });

check('fullscreen-native-hide', 'fullscreen', 'Closing a native-fullscreen window leaves fullscreen first (no empty Space left behind)', async () => {
  const app = await ensureApp();
  expect(app.main, `needs the main-process probe (${app.mainError})`);
  await reset(app);
  await app.mainEval('mainWindow().setFullScreen(true); return true;');
  await app.waitUntil('native fullscreen', () => app.windowState(), (s) => s.fullScreen, 8000);
  await sleep(1200);
  await app.pageEval('await window.winctl.close(); return true;');
  const hidden = await app.waitUntil('hidden and out of fullscreen', () => app.windowState(), (s) => !s.visible && !s.fullScreen, 9000);
  await app.mainEval('app.emit("activate"); return true;');
  const shown = await app.waitUntil('window back, windowed', () => app.windowState(), (s) => s.visible && !s.fullScreen, 8000);
  return pass(`left fullscreen then hid (fullScreen ${hidden.fullScreen}); activate showed it windowed at ${shown.bounds.width}x${shown.bounds.height}. Look at Mission Control for a leftover blank Space (manual).`);
}, { needs: 'main' });

check('deck-mode', 'deck', 'Deck mode: compact size, fixed, traffic lights hidden, own Minimize/Close, and back', async () => {
  const app = await ensureApp();
  expect(app.main, `needs the main-process probe (${app.mainError})`);
  await reset(app);
  const normal = await app.windowState();
  await app.page.pressKey({ ...KEYS.M, meta: true, shift: true });
  const deck = await app.waitUntil('deck-sized window', () => app.windowState(), (s) => s.bounds.height < 400, 8000);
  // The deck skin asks for its own size once it has mounted, so the window is
  // resized (and made fixed) twice; sample until it settles and report flaps.
  const resizableSamples = [deck.resizable];
  for (let i = 0; i < 12; i += 1) {
    await sleep(150);
    resizableSamples.push((await app.windowState()).resizable);
  }
  expect(!resizableSamples.at(-1), `the deck window is still resizable (sampled over 2 s: ${resizableSamples.map((r) => (r ? 'R' : '-')).join('')})`);
  expect(deck.bounds.width >= 280 && deck.bounds.width <= 1600, `deck width ${deck.bounds.width}`);
  const buttons = await app.pageEval(`
    await sleep(600);
    const minimize = document.querySelector('button[aria-label="Minimize"]');
    const close = document.querySelector('button[aria-label="Close"]');
    return { minimize: !!minimize, close: !!close, sidebar: !!document.querySelector('[data-newamp-sidebar]') };`);
  expect(!buttons.sidebar, 'the sidebar is still on screen in deck mode');
  const notes = [];
  if (ctx.screenshots) {
    await app.mainEval('app.focus({ steal: true }); const w = mainWindow(); w.show(); w.focus(); return true;');
    await sleep(700);
    const focused = (await app.windowState()).focused;
    const shot = await windowCapture(app, 'deck-traffic-lights');
    const lights = findTrafficLights(shot.image, shot.image.width / deck.bounds.width);
    // Either answer contradicts one of the two sources (setCompactMode hides the
    // lights, the 2.6.0 changelog says the decks use them), so it is reported
    // rather than failed.
    notes.push(
      lights.blank
        ? 'screenshot was blank (no Screen Recording permission?)'
        : focused
          ? lights.visible
            ? `traffic lights are VISIBLE in deck mode although setCompactMode asks for them hidden (${shot.png})`
            : `traffic lights are hidden in deck mode, as setCompactMode asks; the changelog line saying the decks use them is wrong (${shot.png})`
          : 'window was not active, so grey lights cannot be told from none',
    );
  }
  await app.page.pressKey({ ...KEYS.M, meta: true, shift: true });
  const back = await app.waitUntil('normal window again', () => app.windowState(), (s) => s.bounds.height >= 600 && s.resizable, 8000);
  const drift = Math.abs(back.bounds.width - normal.bounds.width) + Math.abs(back.bounds.height - normal.bounds.height);
  expect(drift <= 6, `window came back ${back.bounds.width}x${back.bounds.height}, was ${normal.bounds.width}x${normal.bounds.height}`);
  return pass(`deck ${deck.bounds.width}x${deck.bounds.height}, fixed size; deck draws its own buttons: minimize ${buttons.minimize}, close ${buttons.close}; restored ${back.bounds.width}x${back.bounds.height}. ${notes.join('; ')}${ctx.screenshots ? '' : ' Traffic-light visibility needs --screenshots or the manual pass.'}`, { normal: normal.bounds, deck: deck.bounds, buttons });
}, { needs: 'main' });

check('window-chrome', 'window', 'Main window chrome: opaque backing, movable, closable; traffic lights present (needs --screenshots)', async () => {
  const app = await ensureApp();
  expect(app.main, `needs the main-process probe (${app.mainError})`);
  await reset(app);
  const state = await app.windowState();
  // The Mac branch of createWindow() sets an opaque #0b0b10 backing instead of
  // the transparent window the other platforms use.
  expect(state.backgroundColor.toLowerCase() === '#0b0b10', `background colour is ${state.backgroundColor}, the Mac branch sets #0b0b10 (not transparent)`);
  expect(state.movable && state.closable && state.minimizable, `window is movable ${state.movable}, closable ${state.closable}, minimizable ${state.minimizable}`);
  const style = `opaque ${state.backgroundColor}, movable, closable, minimizable, fullScreenable ${state.fullScreenable}`;
  if (!ctx.screenshots) return pass(`${style}. titleBarStyle and trafficLightPosition are constructor-only with no getter, so the lights themselves need --screenshots or the manual pass (6.5)`);
  await app.mainEval('app.focus({ steal: true }); const w = mainWindow(); w.show(); w.focus(); return true;');
  await sleep(800);
  const focused = (await app.windowState()).focused;
  const shot = await windowCapture(app, 'main-traffic-lights');
  const lights = findTrafficLights(shot.image, shot.image.width / state.bounds.width);
  if (lights.blank) return info(`${style}. The screenshot came back blank: grant Terminal Screen Recording in System Settings > Privacy & Security`);
  if (!focused) return info(`${style}. The window was not active, so grey lights cannot be told from none; counts ${JSON.stringify(lights.counts)}. Look at ${shot.png}`);
  expect(lights.visible, `no red/yellow/green traffic lights found in the top-left corner (${JSON.stringify(lights.counts)}); see ${shot.png}`);
  return pass(`${style}; red/yellow/green found (${JSON.stringify(lights.counts)} px). ${shot.png}`);
}, { needs: 'main' });

check('projector', 'displays', 'Projector (detached visualizer) opens, lands on a display and closes without touching the main window', async () => {
  const app = await ensureApp();
  expect(app.main, `needs the main-process probe (${app.mainError})`);
  await reset(app);
  const displays = await app.pageEval('return await window.detachedViz.listDisplays();');
  await app.pageEval('await window.detachedViz.open({}); return true;');
  const opened = await app.waitUntil('projector window', () => app.windowState(), (s) => s.windows.some((w) => /detached\.html/.test(w.url) && w.visible), 15000);
  const place = await app.mainEval(`
    const w = BrowserWindow.getAllWindows().find((x) => /detached\\.html/.test(x.webContents.getURL()));
    const d = screen.getDisplayMatching(w.getBounds());
    return { bounds: w.getBounds(), display: d.id, nativeFullscreenable: w.isFullScreenable() };`);
  await app.pageEval('await window.detachedViz.close(); return true;');
  const closed = await app.waitUntil('projector closed', () => app.windowState(), (s) => !s.windows.some((w) => /detached\.html/.test(w.url)), 8000);
  expect(closed.visible, 'closing the projector hid or closed the main window');
  return pass(`${displays.length} display(s); projector opened ${place.bounds.width}x${place.bounds.height} on display ${place.display} and closed cleanly. Fullscreen on a second display and Spaces behaviour are manual checks.`, { displays, place });
}, { needs: 'main', timeoutMs: 120000 });

check('display-and-appearance', 'display', 'Displays, scale factor (Retina) and light/dark appearance', async () => {
  const app = await ensureApp();
  const page = await app.pageEval('return { dpr: window.devicePixelRatio, w: innerWidth, h: innerHeight };');
  let displays = [];
  let dark = null;
  if (app.main) {
    displays = await app.mainEval('return screen.getAllDisplays().map((d) => ({ id: d.id, internal: d.internal, scale: d.scaleFactor, size: d.size, bounds: d.bounds, depth: d.colorDepth, hz: d.displayFrequency }));');
    dark = await app.mainEval('return nativeTheme.shouldUseDarkColors;');
  }
  const styleRead = isMac ? sh('defaults', ['read', '-g', 'AppleInterfaceStyle']) : null;
  const style = styleRead ? parseInterfaceStyle(styleRead.stdout, styleRead.status) : 'n/a';
  return info(`renderer devicePixelRatio ${page.dpr}; ${displays.length} display(s) ${displays.map((d) => `${d.size.width}x${d.size.height}@${d.scale}x`).join(', ')}; system appearance ${style}, app sees dark=${dark}`, { page, displays, style, dark });
}, { platforms: 'any', needs: 'app' });

check('renderer-and-crash-log', 'app', 'No renderer errors, crash events or crash dumps during the run', async () => {
  const app = await ensureApp();
  const events = join(ctx.fixtures.userData, 'diagnostics', 'events.jsonl');
  const bad = existsSync(events)
    ? readFileSync(events, 'utf8').split('\n').filter((l) => /render-process-gone|child-process-gone|main-uncaught|main-unhandled|bootstrap-failed|tray-unavailable/.test(l))
    : [];
  const dumps = join(ctx.fixtures.userData, 'diagnostics', 'crash-dumps');
  const dumpFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (/\.dmp$/i.test(entry.name)) dumpFiles.push(join(dir, entry.name));
    }
  };
  if (existsSync(dumps)) walk(dumps);
  const errors = app.consoleLog.filter((l) => !/Autofill|favicon|Electron Security Warning/i.test(l));
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, 'renderer-console.log'), errors.join('\n'));
  writeFileSync(join(artifactDir, 'app-stderr-tail.log'), app.stderrTail.join('\n'));
  expect(bad.length === 0, `diagnostic events: ${clip(bad.join(' | '), 300)}`);
  expect(dumpFiles.length === 0, `crash dumps written: ${dumpFiles.join(', ')}${ctx.restarts ? ` (the harness had to restart the app ${ctx.restarts} time(s) after a page was lost, so a dump may belong to that)` : ''}`);
  const loadFailures = app.stderrTail.filter((l) => /Library not loaded|code signature|dlopen|sandbox_init|FATAL/i.test(l));
  expect(loadFailures.length === 0, `native load problems in the app's stderr: ${clip(loadFailures.join(' | '), 300)}`);
  return pass(`no crash events or dumps; ${errors.length} renderer error/warning line(s) saved to ${join(artifactDir, 'renderer-console.log')}`);
}, { platforms: 'any', needs: 'app' });

// ---------------------------------------------------------------- quitting

check('quit-cmd-q', 'lifecycle', 'Quit (the Cmd+Q path) from the hidden state ends every process and saves state', async () => {
  const app = await ensureApp();
  expect(app.main, `needs the main-process probe (${app.mainError})`);
  await reset(app, { keepPlaying: true });
  await app.pageEval(`await playTitle(${JSON.stringify(trackByCodec('mp3').title)}); setVolume(0.07); await sleep(400); return true;`);
  // Somewhere that fits this Mac's screen, so the saved place is not clamped on the way back.
  ctx.leftBounds = await app.mainEval(`
    const w = mainWindow();
    const area = screen.getDisplayMatching(w.getBounds()).workArea;
    const width = Math.min(1100, area.width - 120);
    const height = Math.min(700, area.height - 120);
    w.setBounds({ x: area.x + 60, y: area.y + 50, width, height });
    return w.getBounds();`);
  await sleep(1500);
  await app.pageEval('await window.winctl.close(); return true;');
  await app.waitUntil('window hidden', () => app.windowState(), (s) => !s.visible, 5000);
  const family = app.descendants();
  // A role menu item's click() does not run its role in Electron 42 (checked
  // on 42.11: before-quit never fires), so the Quit role's own action,
  // app.quit(), is called instead. It is deferred so the inspector session is
  // gone before the quit runs, the way it would be for a real Cmd+Q.
  const quitThroughProbe = async () => {
    if (!app.main) await app.attachMain();
    await app.mainEval('setTimeout(() => app.quit(), 400); return true;').catch(() => undefined);
    app.detachMain();
  };
  let via = '';
  if (ctx.uiScripting) {
    app.detachMain();
    osascript(`tell application "System Events" to set frontmost of (first process whose unix id is ${app.pid}) to true`);
    await sleep(500);
    const sent = osascript('tell application "System Events" to keystroke "q" using command down');
    via = sent.status === 0 ? 'real Cmd+Q through System Events' : `Cmd+Q not sent (${clip(sent.stderr, 90)})`;
  }
  const quitByAppleEvent = async (target, label) => {
    app.detachMain();
    const event = osascript(`tell application ${target} to quit`, 10000);
    if (event.status === 0) return label;
    await quitThroughProbe();
    return `app.quit() through the main-process probe (Apple event unavailable: ${clip(event.stderr, 80)})`;
  };
  if (!via || via.startsWith('Cmd+Q not sent')) {
    // The dev tree runs inside Electron's own bundle, addressable by its id.
    via = ctx.target.kind === 'packaged'
      ? await quitByAppleEvent(JSON.stringify(ctx.target.appPath), 'quit Apple event (what Dock > Quit sends)')
      : await quitByAppleEvent('id "com.github.Electron"', 'quit Apple event to com.github.Electron (what Dock > Quit sends)');
  }
  const started = Date.now();
  await Promise.race([
    new Promise((resolveExit) => (app.exit ? resolveExit() : app.child.once('exit', resolveExit))),
    sleep(20000),
  ]);
  expect(app.exit, `the app was still running 20 s after the quit request (${via}); app output: ${clip(app.stderrTail.slice(-6).join(' | '), 200)}`);
  const took = Date.now() - started;
  expect(app.exit.code === 0, `exit code ${app.exit.code} (${app.exit.signal ?? 'no signal'}); app output: ${clip(app.stderrTail.slice(-6).join(' | '), 260)}`);
  await sleep(1200);
  const left = family.filter((pid) => sh('kill', ['-0', String(pid)]).status === 0 || (!isMac && sh('ps', ['-p', String(pid)]).status === 0));
  expect(left.length === 0, `${left.length} helper process(es) outlived the quit: ${left.join(', ')}`);
  const saved = JSON.parse(readFileSync(join(ctx.fixtures.userData, 'settings.json'), 'utf8'));
  app.closeSessions();
  return pass(`${via}; exited 0 in ${took} ms; ${family.length} helper process(es) all gone; settings.json volume ${saved.volume}`, { saved: { volume: saved.volume, windowState: saved.windowState } });
}, { needs: 'main', timeoutMs: 120000, retry: false });

check('relaunch-restores', 'lifecycle', 'Relaunch: window opens where it was left, volume kept', async () => {
  const app = await ensureApp();
  const state = app.main ? await app.windowState() : null;
  const volume = await app.pageEval('return transport().volume;');
  expect(Math.abs(volume - 0.07) < 0.012, `volume came back as ${volume}, was 0.07`);
  if (state && ctx.leftBounds) {
    const b = state.bounds;
    const l = ctx.leftBounds;
    expect(Math.abs(b.x - l.x) <= 4 && Math.abs(b.y - l.y) <= 4 && Math.abs(b.width - l.width) <= 4 && Math.abs(b.height - l.height) <= 4, `window opened at ${JSON.stringify(b)}, was left at ${JSON.stringify(l)}`);
  }
  return pass(`volume ${volume}${state ? `, window ${state.bounds.width}x${state.bounds.height} at ${state.bounds.x},${state.bounds.y}` : ''}`);
}, { needs: 'app' });

check('close-setting-quits', 'lifecycle', 'With "Quit NewAmp" chosen, the close button quits the app', async () => {
  const app = await ensureApp();
  await app.pageEval(`await window.newamp.setSettings({ closeButtonBehavior: 'close-app' }); return true;`);
  await reset(app);
  const family = isMac ? app.descendants() : [];
  app.detachMain();
  await app.pageEval('await window.winctl.close(); return true;').catch(() => undefined);
  const started = Date.now();
  await Promise.race([
    new Promise((resolveExit) => (app.exit ? resolveExit() : app.child.once('exit', resolveExit))),
    sleep(12000),
  ]);
  expect(app.exit, `the app is still running after the close button with Quit NewAmp selected; app output: ${clip(app.stderrTail.slice(-6).join(' | '), 260)}`);
  expect(app.exit.code === 0, `exit code ${app.exit.code}; app output: ${clip(app.stderrTail.slice(-6).join(' | '), 260)}`);
  app.closeSessions();
  return pass(`exited 0 in ${Date.now() - started} ms${isMac ? ` (${family.length} helper processes)` : ''}`);
}, { platforms: 'any', needs: 'app', timeoutMs: 120000, retry: false });

check('exclusive-plays', 'audio', 'Bit-Perfect Exclusive on a second output: the app holds hog mode at the track\'s rate while a lossless track plays, Stop hands the device back (2 s of tone at line level)', async () => {
  const helperPath = buildCoreAudioHelper(outDir);
  const listed = coreAudio(helperPath, ['list']);
  expect(Array.isArray(listed.json), `cannot list outputs: ${clip(listed.stdout || listed.stderr, 200)}`);
  const addon = createRequire(import.meta.url)(bundleAddonPath(ctx.target));
  // The system default output is left alone: a second stereo output that
  // accepts 44.1 kHz is taken instead, USB (a DAC) before anything else, or
  // the one NEWAMP_MAC_VERIFY_DAC names.
  const stereoAt44100 = (uid) => {
    const id = addonIdFor(addon, uid);
    return id && addon.probeDevice(id).formats.some((f) => f.channels === 2 && f.sampleRate === 44100) ? id : null;
  };
  const candidates = listed.json
    .filter((d) => !d.isDefault && d.hogPid === -1 && (d.availableRates ?? []).some(([lo, hi]) => lo <= 44100 && 44100 <= hi))
    .map((d) => ({ ...d, addonId: stereoAt44100(d.uid) }))
    .filter((d) => d.addonId)
    .sort((a, b) => Number(/usb/i.test(b.transport)) - Number(/usb/i.test(a.transport)));
  const wanted = (process.env.NEWAMP_MAC_VERIFY_DAC ?? '').toLowerCase();
  const device = (wanted && candidates.find((d) => d.name.toLowerCase().includes(wanted))) || candidates[0];
  if (!device) return skip('no second stereo output that accepts 44.1 kHz; plug in a DAC (or name one with NEWAMP_MAC_VERIFY_DAC)');
  // The engine picks its output path when the app starts, so the throwaway
  // profile is pointed at the device and the app relaunched.
  if (ctx.app?.alive) await ctx.app.kill();
  const settingsPath = join(ctx.fixtures.userData, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  writeFileSync(settingsPath, JSON.stringify({ ...settings, bitPerfectExclusive: true, bitPerfectExclusiveDeviceId: device.addonId }, null, 2));
  const app = await ensureApp();
  const family = new Set([app.pid, ...app.descendants()]);
  const before = coreAudioDeviceState(helperPath, device.uid);
  const title = trackByCodec('flac').title;
  await app.pageEval(`await playTitle(${JSON.stringify(title)}); return true;`);
  await app.waitUntil('hog mode on the device', () => coreAudioDeviceState(helperPath, device.uid), (s) => family.has(s.hogPid), 8000);
  await sleep(1500);
  const during = await app.pageEval(`
    const badge = document.querySelector('[data-newamp-signal-path-badge]');
    return { transport: transport(), badge: badge ? badge.textContent.trim() : null };`);
  const held = coreAudioDeviceState(helperPath, device.uid);
  expect(family.has(held.hogPid), `hog owner is pid ${held.hogPid}, not the app (${app.pid})`);
  expect(held.nominalRate === 44100, `the device clock is ${held.nominalRate} Hz, not the track's 44100`);
  expect(during.transport?.playing && during.transport.time > 1, `the transport is not playing through it: ${JSON.stringify(during.transport)}`);
  await app.mainEval(`const i = app.dock.getMenu().items.find((x) => x.label === 'Stop'); if (!i) throw new Error('no Dock Stop item'); i.click(); return true;`);
  const released = await app.waitUntil('the device released after Stop', () => coreAudioDeviceState(helperPath, device.uid), (s) => s.hogPid === -1 && s.nominalRate === before.nominalRate, 8000);
  return pass(`${device.name}: hog held by the app at 44100 Hz while "${title}" played ${during.transport.time.toFixed(1)} s (badge "${during.badge}"); Stop released it and the clock is back at ${released.nominalRate} Hz`, { device: device.name, uid: device.uid, before, held, during, released });
}, { needs: 'main', timeoutMs: 120000, retry: false });

// ---------------------------------------------------------------- manual items

const MANUAL_ITEMS = [
  ['gatekeeper-first-launch', 'First launch of the GitHub release DMG and of the local build (Gatekeeper)', '6.1'],
  ['wheel-hardware', 'Trackpad and Magic Mouse wheel volume (momentum, Shift+wheel)', '6.2'],
  ['gapless-listening', 'Gapless and crossfade by ear', '6.3'],
  ['hog-dac', 'Exclusive / hog mode with sample-rate switching on a USB DAC', '6.4 and hog-mode-review.md'],
  ['dock-appearance', 'Dock icon, right-click menu, bounce/badge, drag a file onto the icon', '6.5'],
  ['retina', 'Retina rendering of text, art and the visualizer', '6.6'],
  ['menubar-appearance', 'Light and dark menu bar, menu readability', '6.7'],
  ['multi-display-spaces', 'Multiple displays, Spaces, projector fullscreen, unplugging a display', '6.8'],
  ['sleep-wake', 'Sleep and wake during playback', '6.9'],
  ['bluetooth-switching', 'AirPods / Bluetooth / USB output switching', '6.10'],
  ['media-keys-control-center', 'Media keys and Control Center Now Playing', '6.11'],
  ['real-keys', 'Real key presses: Cmd+, Cmd+Q Cmd+W Cmd+M Cmd+arrows (the script sends synthetic events)', '6.12'],
  ['permission-prompts', 'No unexpected permission prompts (Accessibility, Microphone, Local Network, Files); NewAmp posts no notifications', '6.13'],
];

function selectChecks() {
  const only = opt('--only', '')?.split(',').filter(Boolean) ?? [];
  const skipList = opt('--skip', '')?.split(',').filter(Boolean) ?? [];
  return checks.filter((c) => (!only.length || only.includes(c.id) || only.includes(c.area)) && !skipList.includes(c.id) && !skipList.includes(c.area));
}

if (listOnly) {
  console.log(formatTable(checks.map((c) => ({ id: c.id, area: c.area, platform: c.platforms, title: c.title })), [
    { key: 'id', title: 'Id' }, { key: 'area', title: 'Area' }, { key: 'platform', title: 'Runs on' }, { key: 'title', title: 'What it checks' },
  ]));
  console.log(`\n${MANUAL_ITEMS.length} manual items are listed at the end of every run (MAC-PLAN section 6).`);
  process.exit(0);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const TRANSIENT_PAGE_LOSS = /Promise was collected|connection closed|Execution context was destroyed|Target closed|Inspected target navigated/i;

async function main() {
  const startedAt = new Date();
  mkdirSync(outDir, { recursive: true });
  ctx.target = locateTarget();
  console.log(`[mac-verify] target: ${ctx.target.kind}${ctx.target.appPath ? ` ${ctx.target.appPath}` : ` (${ctx.target.exe})`}`);
  if (!isMac) console.log('[mac-verify] REHEARSAL on a non-Mac: only the platform-neutral checks run; this proves the harness plumbing, not macOS behaviour.');

  const selected = selectChecks();
  const needsApp = selected.some((c) => c.needs !== 'none' && (c.platforms === 'any' || isMac || has('--rehearse-all')));
  if (needsApp) {
    const binary = resolveFfmpeg({ repoRoot, appPath: ctx.target.appPath });
    if (!binary) throw new Error('no ffmpeg available to make the test tracks (npm ci installs ffmpeg-static)');
    ctx.fixtures = await prepareFixtures({ root: join(outDir, 'profile'), binary });
    console.log(`[mac-verify] throwaway profile: ${ctx.fixtures.userData}`);
  }

  const rows = [];
  let appBroken = null;
  for (const def of selected) {
    const started = Date.now();
    let result;
    if (def.platforms === 'darwin' && !isMac && !has('--rehearse-all')) result = skip('macOS only');
    else if (def.needs !== 'none' && appBroken) result = skip(`app unavailable: ${appBroken}`);
    else {
      process.stdout.write(`[mac-verify] ${def.id} ... `);
      for (let attempt = 1; ; attempt += 1) {
        try {
          result = await withTimeout(def.fn(ctx), def.timeoutMs ?? perCheckMs, def.id);
        } catch (err) {
          result = { status: 'FAIL', detail: String(err.message ?? err) };
          if (def.id === 'launch' || /before its window appeared|nothing on port/.test(result.detail)) appBroken = result.detail;
          // The page went away under the check (a reload, a recreated window):
          // that says nothing about the behaviour being tested, so try once more
          // on a fresh app.
          if (attempt === 1 && def.retry && def.needs !== 'none' && TRANSIENT_PAGE_LOSS.test(result.detail)) {
            process.stdout.write('(page lost, retrying on a fresh app) ');
            ctx.restarts += 1;
            if (ctx.app) await ctx.app.kill();
            ctx.app = null;
            continue;
          }
        }
        break;
      }
      console.log(result.status);
    }
    rows.push({ id: def.id, area: def.area, title: def.title, status: result.status, detail: result.detail ?? '', evidence: result.evidence ?? null, ms: Date.now() - started });
  }
  if (ctx.app) await ctx.app.kill();

  if (!has('--only') && !has('--skip')) {
    for (const [id, title, section] of MANUAL_ITEMS) rows.push({ id, area: 'manual', title, status: 'MANUAL', detail: `MAC-PLAN section ${section}`, evidence: null, ms: 0 });
  }

  const counts = summarize(rows);
  console.log(`\n${isMac ? '' : 'REHEARSAL (not macOS)\n'}${formatTable(
    rows.map((r, i) => ({ n: i + 1, area: r.area, title: clip(r.title, 70), status: r.status, detail: clip(r.detail, 100) })),
    [{ key: 'n', title: '#' }, { key: 'area', title: 'Area' }, { key: 'title', title: 'Check' }, { key: 'status', title: 'Result' }, { key: 'detail', title: 'Detail' }],
  )}`);
  console.log(`\nPASS ${counts.PASS}  FAIL ${counts.FAIL}  INFO ${counts.INFO}  SKIP ${counts.SKIP}  MANUAL ${counts.MANUAL}`);

  const report = {
    tool: 'mac-verify',
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    rehearsal: !isMac,
    host: { platform: process.platform, arch: arch(), os: release(), node: process.version },
    target: { kind: ctx.target.kind, appPath: ctx.target.appPath, exe: ctx.target.exe, version: pkg.version },
    options: { screenshots: ctx.screenshots, uiScripting: ctx.uiScripting, mute: ctx.options.mute },
    summary: counts,
    results: rows,
  };
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`JSON: ${jsonPath}`);
  if (!has('--keep') && ctx.fixtures) await rm(join(outDir, 'profile'), { recursive: true, force: true }).catch(() => undefined);
  process.exit(counts.FAIL > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`[mac-verify] ${err.message ?? err}`);
  if (ctx.app) await ctx.app.kill().catch(() => undefined);
  process.exit(2);
});
