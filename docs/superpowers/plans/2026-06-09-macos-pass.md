# macOS Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NewAmp behave and feel native on macOS — fix device/UX/cache bugs, add native chrome + menu + Dock lifecycle, and correct the build/signing issues that make the DMG unusable — all platform-gated so Windows/Linux are unchanged.

**Architecture:** Three independently-committable groups. Tier A = pure logic fixes (audio device re-routing, mac music-folder suggestions, APFS cache case-folding). Tier B = native window chrome, app menu, Dock lifecycle. Tier C = ffmpeg cross-arch build correctness + code-sign/notarize preflight (config + scripts; not exercisable without a real packaging run / Developer ID cert). Browser-only and electron-only logic is isolated into small **pure modules** so it can be unit-tested in Node via the existing esbuild-harness pattern (see `scripts/eviland-director-test.mjs`).

**Tech Stack:** Electron, React, TypeScript, electron-builder, ffmpeg-static, esbuild (test harnesses), Node.

Spec: `docs/superpowers/specs/2026-06-09-macos-pass-design.md`. Work on branch `macos-pass` (already created; spec committed there).

---

## File Structure

**Tier A**
- Create `src/audio/device-change.ts` — pure `planDeviceChange(selectedId, availableOutputIds)`.
- Modify `src/audio/engine.ts` — register/teardown `devicechange` listener; `deviceFallback` state + `getDeviceFallback()`.
- Modify `electron/music-folders.ts` — `platform`/`readVolumes` options; darwin suggestions; fixed label.
- Modify `electron/main.ts` (~3808) — darwin first-run seed.
- Create `electron/cache-key-casing.ts` — pure `caseFoldCachePath(canon, platform)`.
- Modify `electron/transcode-cache.ts` — use the helper.

**Tier B**
- Create `electron/app-menu.ts` — pure `buildAppMenuTemplate(platform, { appName, appVersion })`.
- Modify `electron/main.ts` — platform-aware window options (traffic lights); `Menu.setApplicationMenu` on darwin; `app.setAboutPanelOptions`; `registerTray()` darwin early-return.
- Modify `src/components/TitleBar.tsx` — hide Win-style buttons + reserve traffic-light padding on darwin.

**Tier C**
- Create `scripts/lib/macho-arch.mjs` — pure `detectMachOArch(path)`.
- Create `scripts/stage-ffmpeg-for-arch.mjs` — stage the arch-matched ffmpeg-static binary.
- Create `scripts/afterpack-verify-ffmpeg-arch.mjs` — electron-builder `afterPack` arch guard.
- Modify `scripts/package.mjs` — per-arch mac build with staging.
- Modify `package.json` — `build.afterPack`, new `test:*` scripts.
- Create `scripts/verify-mac-signing.mjs` — codesign/spctl preflight.
- Modify `scripts/notarize-artifacts.mjs` — run preflight before submit.
- Create `docs/macos-signing.md`.
- Modify `.github/workflows/ci.yml` — run the new Node tests.

**Test harnesses (new, esbuild-bundle-then-import like `eviland-director-test.mjs`)**
- `scripts/device-change-test.mjs`, `scripts/music-folders-test.mjs`, `scripts/cache-key-casing-test.mjs`, `scripts/app-menu-test.mjs`, `scripts/macho-arch-test.mjs`.

---

## TIER A — Safe logic fixes

### Task A1: CoreAudio device-change re-routing

**Files:**
- Create: `src/audio/device-change.ts`, `scripts/device-change-test.mjs`
- Modify: `src/audio/engine.ts`, `package.json`

- [ ] **Step 1: Write the pure decision module**

Create `src/audio/device-change.ts`:

```ts
// Pure decision logic for how the audio engine should react to a
// `navigator.mediaDevices` "devicechange" event. Kept browser-API-free so it
// is unit-testable in Node (the engine itself touches AudioContext/MediaDevices
// and can't run headless).

export type DeviceChangePlan = 'noop' | 'reapply' | 'fallback';

/**
 * @param selectedId  the engine's pinned output device id, or null when it is
 *                     following the system default.
 * @param availableOutputIds  deviceId values of currently-available
 *                            `audiooutput` devices.
 * - null pinned id            → 'noop'    (already on system default)
 * - pinned id still present   → 'reapply' (re-assert the sink so audio follows)
 * - pinned id gone            → 'fallback'(reset to default + surface a notice)
 */
export function planDeviceChange(
  selectedId: string | null,
  availableOutputIds: readonly string[],
): DeviceChangePlan {
  if (!selectedId) return 'noop';
  return availableOutputIds.includes(selectedId) ? 'reapply' : 'fallback';
}
```

- [ ] **Step 2: Write the failing test**

Create `scripts/device-change-test.mjs`:

```js
// Unit test for planDeviceChange (Eviland-test harness style).
// Run: node scripts/device-change-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/device-change-test-result.txt');
writeFileSync(RESULT, '[device-change-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('src/audio/device-change.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/device-change-bundle.mjs'), logLevel: 'silent',
});
const { planDeviceChange } = await import(pathToFileURL(resolve('tmp/device-change-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const eq = (got, want, msg) => { log.push(`${msg}: ${got}`); if (got !== want) fail(`${msg} — expected ${want}, got ${got}`); };

eq(planDeviceChange(null, ['a', 'b']), 'noop', 'null selection → noop');
eq(planDeviceChange('a', ['a', 'b']), 'reapply', 'present device → reapply');
eq(planDeviceChange('z', ['a', 'b']), 'fallback', 'removed device → fallback');
eq(planDeviceChange('a', []), 'fallback', 'no devices → fallback');

const report = log.join('\n') + '\n' + (pass ? '[device-change-test] PASS' : '[device-change-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
```

- [ ] **Step 3: Run the test — verify PASS**

Run: `node scripts/device-change-test.mjs`
Expected: PASS (the pure module already exists). This test guards the decision logic the engine will use.

- [ ] **Step 4: Wire the listener into the engine — add state + import**

In `src/audio/engine.ts`, add the import near the top (after the existing `@shared/audio-output` import at line 5):

```ts
import { planDeviceChange } from './device-change';
```

In the field block (after `private sampleRateFallback: { requested: number; actual: number } | null = null;` at line 106), add:

```ts
  private deviceFallback: { requestedId: string } | null = null;
  private deviceChangeHandler: (() => void) | null = null;
```

- [ ] **Step 5: Register the listener in `ensureGraph`**

In `src/audio/engine.ts`, in `ensureGraph`, immediately after the existing block (lines 312-314):

```ts
    if (this.outputDeviceId) {
      void this.applyOutputDevice(this.outputDeviceId).catch(() => undefined);
    }
```

add:

```ts
    this.registerDeviceChangeListener();
```

Then add these two private methods (place them right after `applyOutputDevice`, before `playOutputTestTone` at line 668):

```ts
  private registerDeviceChangeListener(): void {
    if (this.deviceChangeHandler) return;
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.addEventListener !== 'function') return;
    const handler = (): void => { void this.handleDeviceChange(); };
    this.deviceChangeHandler = handler;
    md.addEventListener('devicechange', handler);
  }

  private async handleDeviceChange(): Promise<void> {
    try {
      const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
      if (!md || typeof md.enumerateDevices !== 'function' || !this.graph) return;
      const devices = await md.enumerateDevices();
      const outputIds = devices.filter((d) => d.kind === 'audiooutput').map((d) => d.deviceId);
      const plan = planDeviceChange(this.outputDeviceId, outputIds);
      if (plan === 'noop') return;
      if (plan === 'reapply') {
        await this.applyOutputDevice(this.outputDeviceId);
        return;
      }
      // 'fallback': the pinned device vanished — drop to the system default and
      // record it so the Settings UI can surface "output device changed".
      this.deviceFallback = this.outputDeviceId ? { requestedId: this.outputDeviceId } : null;
      this.outputDeviceId = null;
      await this.applyOutputDevice(null);
    } catch (err) {
      // Never let device-change handling throw into the audio path.
      console.warn('[newamp] device-change handling failed', err);
    }
  }
```

- [ ] **Step 6: Add the getter and tear down in `dispose`**

In `src/audio/engine.ts`, after `getSampleRateFallback()` (lines 902-904), add:

```ts
  getDeviceFallback(): { requestedId: string } | null {
    return this.deviceFallback;
  }
```

In `dispose()` (line 1066), after `this.rafId = null;` (line 1074) and before `if (!this.graph) return;` (line 1075), add:

```ts
    if (this.deviceChangeHandler && typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.deviceChangeHandler);
    }
    this.deviceChangeHandler = null;
```

- [ ] **Step 7: Add npm script + typecheck**

In `package.json`, after the line `"test:eviland-director": "node scripts/eviland-director-test.mjs",`, add:

```json
    "test:device-change": "node scripts/device-change-test.mjs",
```

Run: `npm run typecheck` → expect no errors. Run: `node scripts/device-change-test.mjs` → expect PASS.

- [ ] **Step 8: Commit**

```bash
git add src/audio/device-change.ts src/audio/engine.ts scripts/device-change-test.mjs package.json
git commit -m "macOS: re-route audio on CoreAudio device change

Engine now subscribes to mediaDevices devicechange: re-asserts the sink when the
pinned output still exists, and falls back to the system default (recording a
deviceFallback the Settings UI can surface) when it was removed — fixing silent
playback after a headphone unplug / default-output switch on macOS. Decision
logic is a pure, unit-tested module. Listener torn down in dispose().

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A2: Mac-aware music-folder suggestions + first-run seed

**Files:**
- Modify: `electron/music-folders.ts`, `electron/main.ts`
- Create: `scripts/music-folders-test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create `scripts/music-folders-test.mjs`:

```js
// Unit test for darwin music-folder suggestions (esbuild harness).
// Run: node scripts/music-folders-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/music-folders-test-result.txt');
writeFileSync(RESULT, '[music-folders-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/music-folders.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/music-folders-bundle.mjs'), logLevel: 'silent',
});
const { suggestMusicFolders } = await import(pathToFileURL(resolve('tmp/music-folders-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

// Pretend everything under the mac home + one external volume exists.
const homeDir = '/Users/tester';
const existsSet = new Set([
  `${homeDir}/Music`,
  `${homeDir}/Music/Music/Media`,
  '/Volumes/BigDrive/Music',
]);
const result = suggestMusicFolders({
  platform: 'darwin',
  homeDir,
  env: {},
  exists: (p) => existsSet.has(p),
  readVolumes: () => ['BigDrive', 'Macintosh HD'],
});
const paths = result.map((r) => r.path);
log.push('darwin suggestions: ' + JSON.stringify(paths));

if (!paths.includes(`${homeDir}/Music`)) fail('expected ~/Music suggestion on darwin');
if (!paths.includes('/Volumes/BigDrive/Music')) fail('expected /Volumes external-drive suggestion');
if (paths.some((p) => p.startsWith('K:/') || p.startsWith('I:/'))) fail('Windows drive paths leaked into darwin suggestions');
if (result.some((r) => /windows/i.test(r.label))) fail('"Windows Music" label leaked into darwin suggestions');

// Windows path unchanged: K:/music still offered when it exists.
const win = suggestMusicFolders({
  platform: 'win32',
  homeDir: 'C:/Users/tester',
  env: {},
  exists: (p) => p === 'K:/music',
});
if (!win.map((r) => r.path).includes('K:/music')) fail('win32 K:/music suggestion regressed');
log.push('win32 suggestions: ' + JSON.stringify(win.map((r) => r.path)));

const report = log.join('\n') + '\n' + (pass ? '[music-folders-test] PASS' : '[music-folders-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `node scripts/music-folders-test.mjs`
Expected: FAIL — darwin currently has no `platform`/`readVolumes` options and emits Windows paths/labels. (May fail at the call or the assertions — either confirms RED.)

- [ ] **Step 3: Add platform + readVolumes options and darwin branch**

In `electron/music-folders.ts`, replace the import block + options interface (lines 1-15) with:

```ts
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { MusicFolderSuggestion } from '../shared/types.js';

type EnvLike = Record<string, string | undefined>;

function listVolumes(): string[] {
  try {
    return readdirSync('/Volumes');
  } catch {
    return [];
  }
}

export interface MusicFolderSuggestionOptions {
  homeDir?: string;
  env?: EnvLike;
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  readVolumes?: () => string[];
}

export interface DefaultMusicScanRootOptions extends MusicFolderSuggestionOptions {
  fallbackMusicPath?: string;
}
```

Then replace the `suggestMusicFolders` body's candidate-building section. Change the signature/destructuring (lines 17-21) to:

```ts
export function suggestMusicFolders({
  homeDir = homedir(),
  env = process.env,
  exists = existsSync,
  platform = process.platform,
  readVolumes = listVolumes,
}: MusicFolderSuggestionOptions = {}): MusicFolderSuggestion[] {
```

Replace the Windows-specific candidate block (current lines 32-54, i.e. the `candidates.push({ K:/music ... })`, the `profileMusic`/"Windows Music" block, and the OneDrive loop) with this platform-branched block:

```ts
  if (platform === 'darwin') {
    const home = cleanPath(homeDir);
    if (home) {
      candidates.push(
        { path: childPath(home, 'Music'), label: 'Music', reason: 'Default macOS user music folder' },
        { path: childPath(home, 'Music/Music/Media'), label: 'Apple Music library', reason: 'Apple Music media folder' },
        { path: childPath(home, 'Music/iTunes/iTunes Media'), label: 'iTunes library', reason: 'iTunes media folder' },
      );
    }
    for (const vol of readVolumes()) {
      if (vol === 'Macintosh HD' || vol.startsWith('.')) continue;
      candidates.push({
        path: `/Volumes/${vol}/Music`,
        label: `${vol} music`,
        reason: 'External volume music folder',
      });
    }
  } else {
    candidates.push(
      { path: 'K:/music', label: 'K drive music', reason: 'Detected common external music library path' },
      { path: 'I:/music', label: 'I drive music', reason: 'Detected common external music library path' },
    );

    const profileMusic = cleanPath(homeDir) ? childPath(homeDir, 'Music') : '';
    if (profileMusic) {
      candidates.push({
        path: profileMusic,
        label: 'Windows Music',
        reason: 'Default Windows profile music folder',
      });
    }

    for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      const root = cleanPath(env[key]);
      if (!root) continue;
      candidates.push({
        path: childPath(root, 'Music'),
        label: key === 'OneDriveCommercial' ? 'Work OneDrive Music' : 'OneDrive Music',
        reason: `${key} music folder`,
      });
    }
  }
```

(The `configuredRoot` block above it and the dedupe/exists loop below it stay unchanged.)

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `node scripts/music-folders-test.mjs`
Expected: PASS — darwin suggestions include `~/Music` and `/Volumes/BigDrive/Music`, no Windows paths/labels; win32 still offers `K:/music`.

- [ ] **Step 5: Mac-aware first-run seed in main.ts**

In `electron/main.ts`, find line 3808:

```ts
    const candidates = ['K:/music', 'K:\\music', 'C:/Music', 'C:/Users/Public/Music'];
```

Replace it with:

```ts
    const candidates = process.platform === 'darwin'
      ? [app.getPath('music'), ...safeListMacVolumesMusic()]
      : ['K:/music', 'K:\\music', 'C:/Music', 'C:/Users/Public/Music'];
```

Then add this helper near the other top-level helpers in `main.ts` (e.g. just above the function that contains line 3808 — place it at module scope so it's hoisted):

```ts
function safeListMacVolumesMusic(): string[] {
  try {
    return readdirSync('/Volumes')
      .filter((vol) => vol !== 'Macintosh HD' && !vol.startsWith('.'))
      .map((vol) => `/Volumes/${vol}/Music`);
  } catch {
    return [];
  }
}
```

Confirm `readdirSync` is imported in `main.ts` (check the existing `node:fs` import; if only `existsSync` is imported, add `readdirSync` to that import). Run `npm run typecheck` to catch a missing import.

- [ ] **Step 6: Add npm script, typecheck, commit**

In `package.json`, after `"test:device-change": ...`, add:

```json
    "test:music-folders": "node scripts/music-folders-test.mjs",
```

Run: `npm run typecheck` (no errors), `node scripts/music-folders-test.mjs` (PASS).

```bash
git add electron/music-folders.ts electron/main.ts scripts/music-folders-test.mjs package.json
git commit -m "macOS: mac-aware music-folder suggestions + first-run seed

Suggest ~/Music, Apple Music/iTunes media, and /Volumes/* external drives on
darwin (was Windows-only K:/I:/OneDrive with a 'Windows Music' label); seed the
first-run scan from app.getPath('music') + /Volumes on mac. Windows/Linux
unchanged. New unit test covers both platforms.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A3: Case-fold transcode cache key on APFS

**Files:**
- Create: `electron/cache-key-casing.ts`, `scripts/cache-key-casing-test.mjs`
- Modify: `electron/transcode-cache.ts`, `package.json`

- [ ] **Step 1: Write the pure helper**

Create `electron/cache-key-casing.ts`:

```ts
// Whether the transcode-cache key should be case-folded for the given platform.
// Windows (NTFS) and macOS default (APFS, case-INSENSITIVE) treat /A and /a as
// the same file, so the cache key must fold case there to avoid duplicate
// transcodes. Linux (ext4, case-sensitive) must not fold. Pure for testing.

export function caseFoldCachePath(canon: string, platform: NodeJS.Platform): string {
  return platform === 'win32' || platform === 'darwin' ? canon.toLowerCase() : canon;
}
```

- [ ] **Step 2: Write the failing test**

Create `scripts/cache-key-casing-test.mjs`:

```js
// Unit test for caseFoldCachePath (esbuild harness).
// Run: node scripts/cache-key-casing-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/cache-key-casing-test-result.txt');
writeFileSync(RESULT, '[cache-key-casing-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/cache-key-casing.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/cache-key-casing-bundle.mjs'), logLevel: 'silent',
});
const { caseFoldCachePath } = await import(pathToFileURL(resolve('tmp/cache-key-casing-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const p = '/Music/Song.FLAC';
const eq = (got, want, msg) => { log.push(`${msg}: ${got}`); if (got !== want) fail(`${msg} — expected ${want}`); };

eq(caseFoldCachePath(p, 'darwin'), '/music/song.flac', 'darwin folds case (APFS)');
eq(caseFoldCachePath(p, 'win32'), '/music/song.flac', 'win32 folds case');
eq(caseFoldCachePath(p, 'linux'), p, 'linux preserves case');

const report = log.join('\n') + '\n' + (pass ? '[cache-key-casing-test] PASS' : '[cache-key-casing-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
```

- [ ] **Step 3: Run the test — verify PASS**

Run: `node scripts/cache-key-casing-test.mjs`
Expected: PASS (the helper exists). This locks the casing contract before wiring it in.

- [ ] **Step 4: Use the helper in transcode-cache.ts**

In `electron/transcode-cache.ts`, add the import near the top with the other imports:

```ts
import { caseFoldCachePath } from './cache-key-casing.js';
```

Then in `canonicalKey`, replace line 271:

```ts
  if (process.platform === 'win32') canon = canon.toLowerCase();
```

with:

```ts
  canon = caseFoldCachePath(canon, process.platform);
```

- [ ] **Step 5: Typecheck, add npm script, commit**

In `package.json`, after `"test:music-folders": ...`, add:

```json
    "test:cache-key-casing": "node scripts/cache-key-casing-test.mjs",
```

Run: `npm run typecheck` (no errors), `node scripts/cache-key-casing-test.mjs` (PASS).

```bash
git add electron/cache-key-casing.ts electron/transcode-cache.ts scripts/cache-key-casing-test.mjs package.json
git commit -m "macOS: case-fold transcode cache key on APFS

macOS default APFS is case-insensitive, so /A and /a are the same file; fold the
cache key on darwin too (not just win32) to avoid duplicate transcodes. Pure
helper + unit test.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## TIER B — Native look & feel

### Task B1: Native traffic lights

**Files:**
- Modify: `electron/main.ts`, `src/components/TitleBar.tsx`

- [ ] **Step 1: Platform-aware main window options**

In `electron/main.ts`, replace the main `BrowserWindow` option block (lines 404-423) so the mac branch drops `frame`/`transparent` and adds traffic-light positioning:

```ts
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 13 }, backgroundColor: '#0b0b10' }
      : { transparent: true, backgroundColor: '#00000000' }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: !smokeMode,
    },
  });
```

(On macOS, `titleBarStyle: 'hidden'` keeps the traffic lights while hiding the title bar; `frame: false` is harmless alongside it on mac and is what lets the renderer own the rest of the bar. Dropping `transparent: true` on mac avoids the compositor cost for an opaque UI.)

- [ ] **Step 2: Hide Windows-style buttons + reserve traffic-light space in TitleBar**

In `src/components/TitleBar.tsx`, add the platform import + flag. Change the import line:

```ts
import { api, winctl } from '../lib/api';
```

(unchanged — `api.platform` is already available). Inside the component, after the hooks, add:

```ts
  const isMac = api.platform === 'darwin';
```

Change the left cluster `div` (line 21) to reserve space for traffic lights on mac:

```tsx
      <div
        className="titlebar-nodrag flex items-center gap-2"
        style={isMac ? { paddingLeft: 72 } : undefined}
      >
```

Wrap the minimize/maximize/close buttons (the three buttons rendering `_`, `{maximized ? 'RST' : 'MAX'}`, and `X`, lines 70-94) so they don't render on mac. Replace those three `<button>` elements with:

```tsx
        {!isMac && (
          <>
            <button
              className="pxbtn !min-w-[32px]"
              onClick={() => void winctl.minimize()}
              aria-label="Minimize"
              title="Minimize"
            >
              _
            </button>
            <button
              className="pxbtn !min-w-[32px]"
              onClick={() => void winctl.toggleMax()}
              aria-label="Toggle maximize"
              title={maximized ? 'Restore' : 'Maximize'}
            >
              {maximized ? 'RST' : 'MAX'}
            </button>
            <button
              className="pxbtn !min-w-[32px]"
              onClick={() => void winctl.close()}
              aria-label="Close"
              title="Close"
              style={{ color: 'var(--error)' }}
            >
              X
            </button>
          </>
        )}
```

(`PIN` and `DECK` buttons stay for all platforms — they're app features, not window controls.)

- [ ] **Step 3: Typecheck + visual verification**

Run: `npm run typecheck` → no errors.
Run: `npm run dev` on macOS → confirm: native traffic lights appear top-left and are vertically centered in the titlebar; the logo/NEWAMP text does not overlap them; the `_`/`MAX`/`X` buttons are gone; `PIN`/`DECK` remain; dragging the titlebar moves the window. (This step is visual — there is no unit test for native chrome.)

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts src/components/TitleBar.tsx
git commit -m "macOS: native traffic lights instead of Windows-style window buttons

On darwin use titleBarStyle hidden + trafficLightPosition (and drop the
transparent window), and hide the custom min/max/close buttons in TitleBar,
reserving space so the logo clears the traffic lights. Windows/Linux chrome
unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task B2: Native application menu

**Files:**
- Create: `electron/app-menu.ts`, `scripts/app-menu-test.mjs`
- Modify: `electron/main.ts`, `package.json`

- [ ] **Step 1: Write the failing test**

Create `scripts/app-menu-test.mjs`:

```js
// Unit test for buildAppMenuTemplate (esbuild harness).
// Run: node scripts/app-menu-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/app-menu-test-result.txt');
writeFileSync(RESULT, '[app-menu-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/app-menu.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/app-menu-bundle.mjs'), logLevel: 'silent',
});
const { buildAppMenuTemplate } = await import(pathToFileURL(resolve('tmp/app-menu-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

const mac = buildAppMenuTemplate('darwin', { appName: 'NewAmp', appVersion: '1.10.0' });
const roles = mac.map((m) => m.role).filter(Boolean);
log.push('darwin roles: ' + JSON.stringify(roles));
for (const want of ['appMenu', 'editMenu', 'viewMenu', 'windowMenu']) {
  if (!roles.includes(want)) fail(`darwin menu missing role ${want}`);
}

const win = buildAppMenuTemplate('win32', { appName: 'NewAmp', appVersion: '1.10.0' });
log.push('win32 template length: ' + win.length);
if (win.length !== 0) fail('non-darwin should return an empty template (keep current chromeless behavior)');

const report = log.join('\n') + '\n' + (pass ? '[app-menu-test] PASS' : '[app-menu-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `node scripts/app-menu-test.mjs`
Expected: FAIL — `electron/app-menu.ts` does not exist yet (esbuild resolve error / import failure).

- [ ] **Step 3: Write the pure menu-template module**

Create `electron/app-menu.ts`:

```ts
import type { MenuItemConstructorOptions } from 'electron';

export interface AppMenuOptions {
  appName: string;
  appVersion: string;
}

/**
 * The application menu template. On macOS we install a real menu so Cmd-Q/W/M
 * and clipboard shortcuts work and the app gets a proper "NewAmp" + Edit/View/
 * Window menu. On Windows/Linux we keep the chromeless custom-titlebar look by
 * returning an empty template (caller sets the menu to null). Pure — no Electron
 * runtime calls — so it is unit-testable in Node.
 */
export function buildAppMenuTemplate(
  platform: NodeJS.Platform,
  _opts: AppMenuOptions,
): MenuItemConstructorOptions[] {
  if (platform !== 'darwin') return [];
  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}
```

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `node scripts/app-menu-test.mjs`
Expected: PASS — darwin template includes the four roles; win32 returns `[]`.

- [ ] **Step 5: Install the menu in main.ts**

In `electron/main.ts`, add to the imports the `Menu` and `app` (verify both are already imported — `Menu` is used at line 900 and `app` throughout, so just add `buildAppMenuTemplate`):

```ts
import { buildAppMenuTemplate } from './app-menu';
```

In `bootstrap` (the function that calls `registerTray()` at line 3831), add right after the `app.whenReady()`-gated setup begins — concretely, immediately before `registerTray();` at line 3831 — :

```ts
  installApplicationMenu();
```

Add this function at module scope (near `registerTray`):

```ts
function installApplicationMenu(): void {
  const template = buildAppMenuTemplate(process.platform, {
    appName: app.getName(),
    appVersion: app.getVersion(),
  });
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: app.getName(),
      applicationVersion: app.getVersion(),
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    // Keep the existing chromeless custom-titlebar look on Windows/Linux.
    Menu.setApplicationMenu(null);
  }
}
```

- [ ] **Step 6: Typecheck, add npm script, commit**

In `package.json`, after `"test:cache-key-casing": ...`, add:

```json
    "test:app-menu": "node scripts/app-menu-test.mjs",
```

Run: `npm run typecheck` (no errors), `node scripts/app-menu-test.mjs` (PASS).

```bash
git add electron/app-menu.ts electron/main.ts scripts/app-menu-test.mjs package.json
git commit -m "macOS: install a native application menu

Add appMenu/editMenu/viewMenu/windowMenu on darwin so Cmd-Q/W/M and clipboard
shortcuts work and there's a proper app + About menu; keep Windows/Linux
chromeless (menu set to null). Template is a pure, unit-tested function.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task B3: Native Dock lifecycle (no menu-bar icon on mac)

**Files:**
- Modify: `electron/main.ts`

- [ ] **Step 1: Skip the tray on macOS**

In `electron/main.ts`, at the very top of `registerTray()` (line 891), change:

```ts
function registerTray(): void {
  if (tray || smokeMode) return;
```

to:

```ts
function registerTray(): void {
  // macOS uses the Dock lifecycle (close hides the window, app stays in the
  // Dock, Cmd-Q quits) — a persistent menu-bar icon is non-idiomatic, so skip it.
  if (process.platform === 'darwin') return;
  if (tray || smokeMode) return;
```

- [ ] **Step 2: Verify the lifecycle composes (read-through, no code change)**

Confirm by reading the existing handlers that, with `tray` null on mac:
- `win.on('close')` (line 451): `if (!tray || tray.isDestroyed()) return;` → returns before `preventDefault`, so the window actually closes. ✅
- `window-all-closed` (line 3951): `if (!isQuitting && tray && process.platform !== 'darwin') return;` then `if (process.platform !== 'darwin') app.quit();` → on darwin the app stays alive. ✅
- `activate` (line 3958): recreates/show the window from the Dock. ✅
- Cmd-Q → `before-quit` sets `isQuitting = true` → quits. ✅

No code change needed beyond Step 1; this step is a correctness read-through.

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` → no errors.

```bash
git add electron/main.ts
git commit -m "macOS: use the native Dock lifecycle (no menu-bar tray icon)

Skip the tray on darwin so closing the window keeps the app in the Dock
(reopen via the Dock; the existing activate handler already does this) and
Cmd-Q quits — the standard Mac model. Windows/Linux tray unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## TIER C — Build & signing P1s (config + scripts; verify with a real packaging run / cert)

### Task C1: ffmpeg cross-arch correctness

**Files:**
- Create: `scripts/lib/macho-arch.mjs`, `scripts/macho-arch-test.mjs`, `scripts/stage-ffmpeg-for-arch.mjs`, `scripts/afterpack-verify-ffmpeg-arch.mjs`
- Modify: `scripts/package.mjs`, `package.json`

- [ ] **Step 1: Write the failing test for the arch detector**

Create `scripts/macho-arch-test.mjs`:

```js
// Unit test for detectMachOArch. Verifies it reads the Mach-O header and, on
// macOS, that the installed ffmpeg-static binary reports the host arch.
// Run: node scripts/macho-arch-test.mjs
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { arch as hostArch, platform as hostPlatform } from 'node:os';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/macho-arch-test-result.txt');
writeFileSync(RESULT, '[macho-arch-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

const { detectMachOArch, detectMachOArchFromBytes } = await import(pathToFileURL(resolve('scripts/lib/macho-arch.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

// Synthetic Mach-O 64-bit headers: magic 0xFEEDFACF (LE) + cputype.
// CPU_TYPE_X86_64 = 0x01000007, CPU_TYPE_ARM64 = 0x0100000C.
function machoLE(cputype) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cputype >>> 0, 4);
  return b;
}
const arm64Bytes = machoLE(0x0100000c);
const x64Bytes = machoLE(0x01000007);
// Fat binary magic 0xCAFEBABE (big-endian on disk).
const fatBytes = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);

if (detectMachOArchFromBytes(arm64Bytes) !== 'arm64') fail('arm64 header → arm64');
if (detectMachOArchFromBytes(x64Bytes) !== 'x64') fail('x86_64 header → x64');
if (detectMachOArchFromBytes(fatBytes) !== 'universal') fail('fat header → universal');
if (detectMachOArchFromBytes(Buffer.from([0, 1, 2, 3])) !== 'unknown') fail('garbage → unknown');
log.push('synthetic header checks done');

// Real binary check only on macOS where ffmpeg-static is a Mach-O.
const ff = resolve('node_modules/ffmpeg-static/ffmpeg');
if (hostPlatform() === 'darwin' && existsSync(ff)) {
  const got = detectMachOArch(ff);
  const want = hostArch() === 'arm64' ? 'arm64' : 'x64';
  log.push(`installed ffmpeg arch: ${got} (host ${want})`);
  if (got !== want && got !== 'universal') fail(`installed ffmpeg arch ${got} != host ${want}`);
} else {
  log.push('skipping real-binary check (not darwin or ffmpeg-static absent)');
}

const report = log.join('\n') + '\n' + (pass ? '[macho-arch-test] PASS' : '[macho-arch-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `node scripts/macho-arch-test.mjs`
Expected: FAIL — `scripts/lib/macho-arch.mjs` does not exist (import error).

- [ ] **Step 3: Write the arch-detector module**

Create `scripts/lib/macho-arch.mjs`:

```js
import { openSync, readSync, closeSync } from 'node:fs';

// Mach-O cputype values (low 24 bits; bit 0x01000000 = 64-bit flag).
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

/**
 * Detect the architecture of a Mach-O (macOS) binary from its leading bytes.
 * Returns 'arm64' | 'x64' | 'universal' | 'unknown'.
 */
export function detectMachOArchFromBytes(buf) {
  if (!buf || buf.length < 8) return 'unknown';
  // Fat/universal binary: magic 0xCAFEBABE or 0xBEBAFECA (big-endian on disk).
  const beMagic = buf.readUInt32BE(0);
  if (beMagic === 0xcafebabe || beMagic === 0xbebafeca) return 'universal';
  // Thin Mach-O 64-bit: 0xFEEDFACF (LE 0xCFFAEDFE on disk for LE hosts).
  const leMagic = buf.readUInt32LE(0);
  const isMacho64 = leMagic === 0xfeedfacf || buf.readUInt32BE(0) === 0xfeedfacf;
  if (!isMacho64) return 'unknown';
  // cputype is the next 32-bit word; read in the same endianness as the magic.
  const cpuLE = buf.readUInt32LE(4);
  const cpuBE = buf.readUInt32BE(4);
  const cpu = leMagic === 0xfeedfacf ? cpuLE : cpuBE;
  if (cpu === CPU_TYPE_ARM64) return 'arm64';
  if (cpu === CPU_TYPE_X86_64) return 'x64';
  return 'unknown';
}

/** Detect the arch of a Mach-O binary at `path`. */
export function detectMachOArch(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(8);
    readSync(fd, buf, 0, 8, 0);
    return detectMachOArchFromBytes(buf);
  } finally {
    closeSync(fd);
  }
}
```

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `node scripts/macho-arch-test.mjs`
Expected: PASS — synthetic headers classify correctly; on macOS the installed ffmpeg matches the host arch.

- [ ] **Step 5: Write the per-arch ffmpeg staging script**

Create `scripts/stage-ffmpeg-for-arch.mjs`:

```js
// Ensure node_modules/ffmpeg-static/ffmpeg is the binary for the requested mac
// arch by re-running ffmpeg-static's installer with npm_config_platform/arch
// (its install script honors these env vars — a pure download, no execution of
// the cross-arch binary). Verifies the result with detectMachOArch and exits
// non-zero on mismatch. Usage: node scripts/stage-ffmpeg-for-arch.mjs <arm64|x64>
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectMachOArch } from './lib/macho-arch.mjs';

const target = process.argv[2];
if (target !== 'arm64' && target !== 'x64') {
  console.error(`stage-ffmpeg-for-arch: expected arch arm64|x64, got ${target}`);
  process.exit(2);
}

const installer = resolve('node_modules/ffmpeg-static/install.js');
if (!existsSync(installer)) {
  console.error(`stage-ffmpeg-for-arch: ${installer} not found (run npm ci first)`);
  process.exit(2);
}

const r = spawnSync(process.execPath, [installer], {
  stdio: 'inherit',
  env: { ...process.env, npm_config_platform: 'darwin', npm_config_arch: target },
});
if (r.status !== 0) {
  console.error(`stage-ffmpeg-for-arch: ffmpeg-static install failed for ${target}`);
  process.exit(r.status ?? 1);
}

const bin = resolve('node_modules/ffmpeg-static/ffmpeg');
const got = detectMachOArch(bin);
if (got !== target && got !== 'universal') {
  console.error(`stage-ffmpeg-for-arch: staged ffmpeg arch ${got} != requested ${target}`);
  process.exit(1);
}
console.log(`stage-ffmpeg-for-arch: ffmpeg staged for ${target} (detected ${got})`);
```

- [ ] **Step 6: Write the afterPack arch guard**

Create `scripts/afterpack-verify-ffmpeg-arch.mjs`:

```js
// electron-builder afterPack hook: on macOS targets, assert the unpacked
// ffmpeg-static binary's arch matches the arch being packaged. Fails the build
// on mismatch so a wrong-arch ffmpeg can never ship silently (the bug where the
// x64 DMG got an arm64 ffmpeg and every transcoded format 503'd).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Arch } from 'electron-builder';
import { detectMachOArch } from './lib/macho-arch.mjs';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const want = context.arch === Arch.arm64 ? 'arm64' : context.arch === Arch.x64 ? 'x64' : null;
  if (!want) return;
  const ffmpeg = join(
    context.appOutDir,
    'NewAmp.app',
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'ffmpeg-static',
    'ffmpeg',
  );
  if (!existsSync(ffmpeg)) {
    throw new Error(`afterPack: bundled ffmpeg not found at ${ffmpeg}`);
  }
  const got = detectMachOArch(ffmpeg);
  if (got !== want && got !== 'universal') {
    throw new Error(`afterPack: bundled ffmpeg arch ${got} does not match packaged arch ${want} (${ffmpeg})`);
  }
  console.log(`afterPack: ffmpeg arch OK (${got}) for ${want}`);
}
```

- [ ] **Step 7: Wire afterPack + per-arch staging into the build**

In `package.json`, add an `afterPack` key to the `build` object (place it next to `asarUnpack`):

```json
    "afterPack": "scripts/afterpack-verify-ffmpeg-arch.mjs",
```

In `scripts/package.mjs`, replace the `--mac` case in `electronBuilderTargetArgs` (the line `if (args.includes('--mac')) return [['--mac']];`) with per-arch invocations:

```js
  if (args.includes('--mac')) return [['--mac', '--arm64'], ['--mac', '--x64']];
```

Then make the build loop stage the matching ffmpeg before each mac arch. In `scripts/package.mjs`, find the build loop:

```js
for (const args of electronBuilderTargetArgs(requestedTargets)) {
```

and at the very top of that loop body (before the `run(electronBuilder, ...)` call) add:

```js
  const macArch = args.includes('--arm64') ? 'arm64' : args.includes('--x64') ? 'x64' : null;
  if (args.includes('--mac') && macArch) {
    run(process.execPath, [join(repoRoot, 'scripts', 'stage-ffmpeg-for-arch.mjs'), macArch]);
  }
```

(`run` and `join`/`repoRoot` are already defined in package.mjs.)

- [ ] **Step 8: Add an ffmpeg-runs smoke to the mac launch smoke**

In `scripts/packaged-mac-launch-smoke.mjs`, after the block that resolves `appPath` and asserts the executable exists, add a check that the bundled ffmpeg runs (host arch):

```js
import { spawnSync } from 'node:child_process';
// ... after appPath is resolved ...
const bundledFfmpeg = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg');
assert.ok(existsSync(bundledFfmpeg), `bundled ffmpeg should exist: ${bundledFfmpeg}`);
const ff = spawnSync(bundledFfmpeg, ['-version'], { encoding: 'utf8' });
assert.equal(ff.status, 0, `bundled ffmpeg -version should exit 0, got ${ff.status} (${ff.stderr || ''})`);
```

(Place the `import { spawnSync }` with the other imports at the top; `join`/`existsSync`/`assert` are already imported.)

- [ ] **Step 9: Add npm test script, typecheck, commit**

In `package.json`, after `"test:app-menu": ...`, add:

```json
    "test:macho-arch": "node scripts/macho-arch-test.mjs",
```

Run: `npm run typecheck` (no errors — note: package.mjs/afterpack are .mjs, not typechecked, but the import of `electron-builder` in afterpack must resolve at build time; it's a devDependency so it resolves). Run: `node scripts/macho-arch-test.mjs` (PASS).

**Verification note:** the per-arch build + afterPack guard + ffmpeg-runs smoke can only be fully exercised by `npm run package:mac` on a macOS machine. Do NOT mark the build-orchestration parts "verified" without that run — only the `detectMachOArch` unit test is proven here.

```bash
git add scripts/lib/macho-arch.mjs scripts/macho-arch-test.mjs scripts/stage-ffmpeg-for-arch.mjs scripts/afterpack-verify-ffmpeg-arch.mjs scripts/package.mjs scripts/packaged-mac-launch-smoke.mjs package.json
git commit -m "macOS: fix ffmpeg cross-arch packaging (no more wrong-arch 503s)

Build the mac DMG per-arch, staging the matching ffmpeg-static binary before
each arch, and add an afterPack guard that fails the build if the bundled
ffmpeg's Mach-O arch doesn't match the packaged arch. Mach-O arch detector is
pure + unit-tested; the mac-launch smoke now spawns the bundled ffmpeg.
Build orchestration requires a real package:mac run to fully verify.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task C2: Code-sign + notarize preflight

**Files:**
- Create: `scripts/verify-mac-signing.mjs`, `docs/macos-signing.md`
- Modify: `scripts/notarize-artifacts.mjs`

- [ ] **Step 1: Read the current notarize script**

Read `scripts/notarize-artifacts.mjs` fully to learn its structure (how it locates the `.app`/`.dmg`, how it env-gates on `NEWAMP_APPLE_ID`, and where submission happens). The preflight must run before submission and reuse the same app-discovery approach. (No change yet — this is a read step so the next steps match the existing style.)

- [ ] **Step 2: Write the signing-verification preflight**

Create `scripts/verify-mac-signing.mjs`:

```js
// Preflight: verify the packaged macOS .app is Developer-ID-signed and accepted
// by Gatekeeper BEFORE we submit it to Apple's notary service. Apple rejects
// ad-hoc/unsigned hardened-runtime apps, so submitting one wastes a round-trip
// and (in CI) fails confusingly. Exits 0 with a notice when there's nothing to
// check (non-darwin, or no packaged .app yet) to match the env-gated style of
// the other release scripts. Usage: node scripts/verify-mac-signing.mjs [appPath]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.platform !== 'darwin') {
  console.log('[verify-mac-signing] not darwin — skipping');
  process.exit(0);
}

const candidates = [
  process.argv[2],
  resolve('release/mac-arm64/NewAmp.app'),
  resolve('release/mac/NewAmp.app'),
  resolve('release/mac-x64/NewAmp.app'),
].filter(Boolean);
const appPath = candidates.find((p) => existsSync(p));
if (!appPath) {
  console.log('[verify-mac-signing] no packaged .app found — skipping (run package:mac first)');
  process.exit(0);
}

const codesign = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { encoding: 'utf8' });
const spctl = spawnSync('spctl', ['-a', '-vvv', '-t', 'install', appPath], { encoding: 'utf8' });

const codesignOk = codesign.status === 0;
// spctl prints the signing authority on stderr; require a Developer ID Application authority.
const spctlOut = `${spctl.stdout || ''}${spctl.stderr || ''}`;
const devIdOk = spctl.status === 0 && /Developer ID Application/.test(spctlOut);

console.log(`[verify-mac-signing] app: ${appPath}`);
console.log(`[verify-mac-signing] codesign --verify: ${codesignOk ? 'OK' : 'FAIL'}`);
console.log(`[verify-mac-signing] spctl assess: ${devIdOk ? 'Developer ID OK' : 'NOT Developer-ID-accepted'}`);

if (!codesignOk || !devIdOk) {
  console.error(
    '[verify-mac-signing] App is not Developer-ID-signed/accepted. ' +
    'Set CSC_LINK/CSC_KEY_PASSWORD for package:mac (see docs/macos-signing.md). ' +
    'Refusing to notarize an unsignable artifact.',
  );
  console.error(codesign.stderr || '');
  console.error(spctlOut);
  process.exit(1);
}
console.log('[verify-mac-signing] OK — Developer ID signed.');
```

- [ ] **Step 3: Run the preflight locally to confirm it skips cleanly**

Run: `node scripts/verify-mac-signing.mjs`
Expected (no packaged app present): exits 0 with `no packaged .app found — skipping`. (On non-darwin it prints `not darwin — skipping` and exits 0.) This confirms the script is safe to wire in.

- [ ] **Step 4: Run the preflight before notarization**

In `scripts/notarize-artifacts.mjs`, add a preflight call before the submission logic. Near the top of the main flow (after imports / before it submits to notarytool), add:

```js
import { spawnSync as _spawnSyncPreflight } from 'node:child_process';
// ... at the start of the notarize flow, before submitting:
const preflight = _spawnSyncPreflight(process.execPath, [new URL('./verify-mac-signing.mjs', import.meta.url).pathname], { stdio: 'inherit' });
if (preflight.status !== 0) {
  console.error('[notarize] signing preflight failed — aborting notarization');
  process.exit(preflight.status ?? 1);
}
```

(Adapt the exact insertion point to the file's structure found in Step 1: it must run after a `.app` exists and before `notarytool submit`. If the script already early-returns when `NEWAMP_APPLE_ID` is unset, place the preflight after that gate so local no-cred runs still skip cleanly.)

- [ ] **Step 5: Document the signing setup**

Create `docs/macos-signing.md`:

```markdown
# macOS Code Signing & Notarization

NewAmp ships a hardened-runtime macOS app, so Apple's notary service requires it
to be signed with a **Developer ID Application** certificate. Without signing,
`package:mac` produces an ad-hoc-signed `.app`; the notarize preflight
(`scripts/verify-mac-signing.mjs`) will (correctly) block notarization, and end
users would otherwise see "NewAmp is damaged / cannot verify developer".

## What you need

1. An Apple Developer account ($99/yr) and a **Developer ID Application** cert.
2. Export it as a `.p12` (Keychain Access → export) with a password.
3. An app-specific password for your Apple ID (appleid.apple.com → Sign-In & Security).

## Environment variables

For signing (consumed by electron-builder during `npm run package:mac`):

| Var | Value |
|-----|-------|
| `CSC_LINK` | path to (or base64 of) the Developer ID `.p12` |
| `CSC_KEY_PASSWORD` | the `.p12` export password |

For notarization (consumed by `npm run release:notarize`):

| Var | Value |
|-----|-------|
| `NEWAMP_APPLE_ID` | your Apple ID email |
| `NEWAMP_APPLE_PASSWORD` | the app-specific password |
| `NEWAMP_APPLE_TEAM_ID` | your 10-char Apple Team ID |

In CI these are GitHub Actions secrets already referenced by `.github/workflows/release.yml`.

## Verify a build

```bash
npm run package:mac
node scripts/verify-mac-signing.mjs            # must report "Developer ID signed"
npm run release:notarize                        # runs the preflight, then notarytool + staple
```

`codesign --verify --deep --strict` and `spctl -a -t install` are the source of
truth — the preflight runs both and fails if the app isn't Developer-ID-accepted.
```

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-mac-signing.mjs scripts/notarize-artifacts.mjs docs/macos-signing.md
git commit -m "macOS: add code-sign/notarize preflight + signing docs

verify-mac-signing.mjs runs codesign --verify + spctl assess and fails if the
.app isn't Developer-ID-accepted; notarize-artifacts.mjs now runs it as a hard
preflight so we never submit an unsignable artifact to Apple. Document the
required CSC_*/Apple env vars. (Unexercised until a Developer ID cert exists;
skips cleanly without one.)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task D: Wire the new Node tests into CI + final verification

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the Tier-A/B/C unit tests to CI**

In `.github/workflows/ci.yml`, after the existing `Test — Eviland Director` step (added by the prior branch; if not present, add after `Smoke — visualizer module exports`), add:

```yaml
      - name: Test — macOS logic (device-change, music-folders, cache-key, app-menu, macho-arch)
        run: |
          npm run test:device-change
          npm run test:music-folders
          npm run test:cache-key-casing
          npm run test:app-menu
          npm run test:macho-arch
```

- [ ] **Step 2: Run the full gate locally**

Run each and confirm:
- `npm run typecheck` → no errors
- `node scripts/device-change-test.mjs` → PASS
- `node scripts/music-folders-test.mjs` → PASS
- `node scripts/cache-key-casing-test.mjs` → PASS
- `node scripts/app-menu-test.mjs` → PASS
- `node scripts/macho-arch-test.mjs` → PASS
- `node scripts/verify-mac-signing.mjs` → exits 0 (skips cleanly)
- `npm run smoke:visualizer` → passes (no regression)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "macOS: gate the new platform-logic unit tests in CI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** A1→Task A1; A2→Task A2; A3→Task A3; B1→Task B1; B2→Task B2; B3→Task B3; C1→Task C1; C2→Task C2; CI/testing→Task D. All spec sections mapped.
- **Type/name consistency:** `planDeviceChange(selectedId, availableOutputIds)`, `getDeviceFallback()`, `caseFoldCachePath(canon, platform)`, `buildAppMenuTemplate(platform, {appName, appVersion})`, `detectMachOArch(path)`/`detectMachOArchFromBytes(buf)`, `suggestMusicFolders({platform, readVolumes, ...})` are each defined once and referenced consistently in their tests and call sites.
- **Verifiability honesty:** Tier A + B2 are unit-tested in Node; B1/B3 are visual/behavioral (verified by running on macOS — explicitly noted, no fake tests); C1 build orchestration + C2 signing require a real `package:mac` / Developer ID cert (explicitly flagged; only the pure helpers are unit-tested here).
- **Platform-gating:** every change branches on `process.platform`/`api.platform` or is additive; Windows/Linux behavior is preserved (win32 music-folder path retained, non-darwin menu set to null to keep current look, non-mac window options unchanged).
- **Assumption to verify during execution:** the unpacked-ffmpeg path inside the `.app` (`Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg`) is the standard electron-builder layout; confirm against an actual packaged `.app` during the C1 packaging run and adjust the path in both `afterpack-verify-ffmpeg-arch.mjs` and the mac-launch smoke if electron-builder nests it differently.
