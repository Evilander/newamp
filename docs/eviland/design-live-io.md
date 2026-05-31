# Eviland — Live I/O Design

> Design contract for three NEW capabilities, deliberately disjoint from
> `src/visualizer/eviland.ts` (which is verified working — do not edit its
> shaders, passes, or warp formulas as part of this work):
>
> 1. **Live audio input** — mic / line-in / interface routed into the existing
>    `AudioEngine` so the reactor + recorder + detached window all see it.
> 2. **Detached visualizer window** — the user's #1 priority. A second
>    `BrowserWindow` the user can shove onto a projector or second monitor and
>    fullscreen, while the main NewAmp UI stays browsable. Frame production
>    happens once, in the main renderer; the detached window is a thin
>    `EvilandFrame` consumer.
> 3. **Video recorder** — canvas + audio → WebM via `MediaRecorder`, plus a
>    note on the deterministic offline export through `ffmpeg-static`.
>
> This document is the API + control-flow contract. Everything is anchored to
> the current tree (see `docs/eviland/map-integration.md` for line-level
> citations of the surfaces we touch) and follows the existing house style:
>
> - ES modules everywhere. No `require`.
> - Electron IPC via `ipcMain.handle` + `ipcRenderer.invoke`, surfaced through
>   `contextBridge.exposeInMainWorld(...)` in `electron/preload.ts`.
> - Per-feature smoke script under `scripts/`, runnable on Windows.
> - Frame transport uses Electron's `MessageChannelMain` so the per-frame data
>   path does NOT round-trip through main.
> - No new dependencies. `ffmpeg-static` is already in `package.json`.

---

## 0. Module map at a glance

```
NEW FILES (no overlap with eviland.ts):
  src/audio/live-input.ts                       device enum + getUserMedia + helpers
  src/visualizer/frame-bus.ts                   reactor → consumers fan-out + IPC port
  src/recording/live-recorder.ts                canvas + MSADest → MediaRecorder helper
  src/recording/offline-export.ts               frame-log replay orchestration (note only)
  src/detached/main.tsx                         detached window renderer entry
  detached.html                                 detached window HTML entry
  scripts/live-input-smoke.mjs                  §1 smoke
  scripts/detached-viz-smoke.mjs                §2 smoke
  scripts/live-recorder-smoke.mjs               §3 smoke

EDITED FILES (additive only — never delete renderer or shader code):
  electron/main.ts                              + permission handler, + detached-viz IPCs, + display events
  electron/preload.ts                           + liveInput / detachedViz / recorder bridges
  src/audio/engine.ts                           + attachLiveInput / stopLiveInput / setLiveMonitoring
  src/components/Visualizer.tsx                 eviland branch publishes through frameBus
  src/components/FullscreenVisualizer.tsx       + Live Input source picker, + Pop Out controls, replace toggleRecord
  src/components/views/SettingsView.tsx         + audio-input device picker block (optional v2)
  vite.config.ts                                + detached.html as a second rollup input
  package.json                                  + smoke:live-input, smoke:detached, smoke:record scripts
```

Disjoint write set for parallel work:
- Worker A: live input (`live-input.ts`, `engine.ts` additions, `preload.ts` `liveInput` block, source-picker UI).
- Worker B: detached window (`main.ts` IPC + window factory, `preload.ts` `detachedViz` block, `detached.html`, `src/detached/main.tsx`, `frame-bus.ts`, `Visualizer.tsx` publish refactor, Pop Out controls).
- Worker C: recorder (`live-recorder.ts`, `FullscreenVisualizer.tsx` `toggleRecord` replacement, `preload.ts` chunked-capture IPCs if added).

The only file with multi-worker contention is `electron/preload.ts`. Serialize by sectioning the file (`liveInput` block, `detachedViz` block, `recorder` block) and merging in that order.

---

## 1. Live audio input

### 1.1 Module — `src/audio/live-input.ts` (NEW)

Pure renderer-side module. No NewAmp imports. Easy to lift into `@eviland/core` later.

```ts
// src/audio/live-input.ts
export interface AudioInputDevice {
  /** Opaque MediaDevices ID. Stable per-origin + per-session in Chromium. */
  deviceId: string;
  /** Human label, e.g. "Focusrite Scarlett 2i2 USB (Input 1)". May be '' until permission granted. */
  label: string;
  /** Same groupId across input+output of the same physical device. Useful for "default interface" UI grouping. */
  groupId: string;
}

export interface OpenLiveInputOptions {
  /** Exact device. Omit to use system default. */
  deviceId?: string;
  /** 1 or 2. Hint only — driver decides. Default 2. */
  channelCount?: 1 | 2;
  /** Hint only — AudioContext resamples anyway. Default unset (use context rate). */
  sampleRate?: number;
}

export interface LiveInputCaps {
  /** True when navigator.mediaDevices.getUserMedia exists (always true under Electron). */
  supported: boolean;
  /** True when at least one labelled audioinput device is enumerable (proxy for "user granted permission previously"). */
  permissionPrimed: boolean;
}

/** One-shot capability probe. Cheap. Safe to call on app boot. */
export function probeLiveInput(): Promise<LiveInputCaps>;

/**
 * Enumerate audio input devices. If labels are empty (user has never granted),
 * issues a probe getUserMedia({audio:true}) to unlock labels, then immediately
 * stops the probe stream. Returns deviceIds without labels if the user denies.
 */
export function listAudioInputDevices(): Promise<AudioInputDevice[]>;

/**
 * Open a MUSIC-GRADE input stream. ALWAYS sets:
 *   echoCancellation: false, autoGainControl: false, noiseSuppression: false
 * because voice DSP destroys music. Caller owns the returned stream and MUST
 * stop its tracks when done (engine.stopLiveInput does this).
 *
 * Throws DOMException on permission denied / device gone / over-constrained.
 */
export function openLiveInputStream(opts?: OpenLiveInputOptions): Promise<MediaStream>;

/**
 * Subscribe to OS-level device hot-plug events. Returns an unsubscribe fn.
 * Triggers on USB plug/unplug, default-device change, etc.
 */
export function watchDeviceChanges(onChange: () => void): () => void;

/**
 * Inspect what we actually got. Useful for the "this interface is locked to
 * 44.1k" hint in UI. Reads from track.getSettings().
 */
export interface LiveInputResolved {
  deviceId?: string;
  groupId?: string;
  sampleRate?: number;
  channelCount?: number;
  latency?: number;
}
export function resolveLiveInputStream(stream: MediaStream): LiveInputResolved;
```

### 1.2 Engine additions — `src/audio/engine.ts` (EDIT)

Add to class `AudioEngine`. Insertion point: directly after the `getOnsetTimeData` block (~line 920) so the live-input methods sit next to other audio-source-management methods.

```ts
// src/audio/engine.ts — additions to AudioEngine

// State
private liveSource: MediaStreamAudioSourceNode | null = null;
private liveStream: MediaStream | null = null;
private liveActive = false;
private liveMonitor = false;
private prevDeckGain0 = 0;
private prevDeckGain1 = 0;

isLiveInputActive(): boolean;

/**
 * Mount a live MediaStream into the analyser bus.
 *
 * Routing decision (deliberate, see "Why not inputGain?" below):
 *   source → analyser, onsetAnalyser, stereoSplitter ONLY.
 *   source → masterGain ONLY when setLiveMonitoring(true) is called.
 *
 * Side effects:
 *   - Both decks are paused (deck.el.pause()) and their gain ramped to 0 so
 *     the user does not hear file + mic at once.
 *   - track.onended is wired to call stopLiveInput() automatically.
 *   - Previous deck gain values are stashed so stopLiveInput() can restore.
 *
 * Throws nothing — silently no-ops if the stream has no audio tracks.
 */
attachLiveInput(stream: MediaStream): void;

/**
 * Restore deck playback path. Idempotent. After this:
 *   - liveSource is disconnected and dropped.
 *   - All tracks on the previous stream are .stop()'d.
 *   - Deck gains return to their pre-live values.
 *   - liveActive = false.
 */
stopLiveInput(): void;

/**
 * Toggle whether the live source feeds masterGain → limiter → destination.
 * Default false (analyser-only) to prevent feedback. UI MUST display a warning
 * before enabling, and SHOULD be disabled by default for mic input.
 */
setLiveMonitoring(on: boolean): void;
isLiveMonitoring(): boolean;
```

**Why not connect live source to `inputGain` (which feeds EQ → master → limiter → destination)?** Because (a) inputGain → masterGain → ctx.destination would route a microphone to the same speakers it hears = feedback loop; (b) ReplayGain is a per-track loudness compensation that does not apply to live sources; (c) the user's master volume slider should not affect their audio-interface input level. Tapping only the analyser bus keeps the reactor + recorder working with zero feedback risk.

**Sample rate:** verified — `MediaStreamAudioSourceNode` resamples to `AudioContext.sampleRate`. The analyser pipeline is rate-agnostic; the reactor reads `engine.getSampleRate()` per remount in `Visualizer.tsx`. No special handling needed.

### 1.3 Electron permission handler — `electron/main.ts` (EDIT)

Insertion point: define `registerMediaPermissions()` directly above `createWindow()` (~line 399). Call it once from inside `app.whenReady().then(...)` before the first `createWindow()` call.

```ts
// electron/main.ts — new function before createWindow()
import { session } from 'electron';

function registerMediaPermissions(): void {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission === 'media') {
      // Electron currently uses `mediaTypes: string[]` in details; older builds
      // used `mediaType: string`. Accept either.
      const d = details as { mediaTypes?: string[]; mediaType?: string };
      const types = d.mediaTypes ?? (d.mediaType ? [d.mediaType] : []);
      if (!types.length || types.includes('audio')) return callback(true);
      return callback(false); // video / unknown — deny, we never request them
    }
    callback(false);
  });

  ses.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    if (permission === 'media') {
      const t = (details as { mediaType?: string }).mediaType;
      return !t || t === 'audio' || t === 'unknown';
    }
    return false;
  });

  // Belt-and-suspenders: deny HID / serial / USB device permissions we never use.
  ses.setDevicePermissionHandler(() => false);
}
```

`webPreferences` already in use (`sandbox: false`, `contextIsolation: true`, `webSecurity: true`) are compatible with `mediaDevices.getUserMedia` under both `http://localhost:5173` (dev) and the `newamp-app://` custom protocol (prod). Do not change them.

### 1.4 Preload bridge — `electron/preload.ts` (EDIT)

Insertion point: new `liveInput` namespace exposed near the existing `winctl` block (~line 354). Nothing here is actually Electron-IPC; it's a thin re-export of the renderer-only `src/audio/live-input.ts` module so React components can call `window.liveInput.openStream(...)` without import-path gymnastics. (Alternative: import `live-input.ts` directly from components and skip this bridge. Pick one and apply it consistently — directly is simpler.)

The ONLY thing that strictly needs IPC for live input is the permission handler (already in §1.3, main-side only). The renderer's `getUserMedia` call works directly through the standard browser API.

### 1.5 UI wiring — `src/components/FullscreenVisualizer.tsx` (EDIT)

Two new affordances in the Settings popover (`viz-setting-row` group):

```
[ Source ]   ( File ) ( Live Input )
[ Device ]   [ Focusrite Scarlett 2i2 ▼ ]   (only when Live Input)
[ Monitor ]  [ off ]   ⚠ feedback risk     (only when Live Input)
```

Behavior:
- `File`: `engine.stopLiveInput()`. Next user `play()` unmutes deck gain via the existing crossfade path.
- `Live Input`: call `listAudioInputDevices()`, populate dropdown, then on pick:
  ```ts
  const stream = await openLiveInputStream({ deviceId });
  engine.attachLiveInput(stream);
  ```
- `Monitor` toggle: `engine.setLiveMonitoring(on)`. Show a one-time toast `"⚠ Monitoring sends input to speakers. Use headphones to avoid feedback."`
- `devicechange` listener: refresh the dropdown.
- If `track.ended` fires (device unplugged), engine auto-calls `stopLiveInput()`; UI shows toast `"Live input device removed."`.

When `liveActive`, the transport bar SHOULD hide play/pause/seek and replace them with an input-level meter (reuse the existing `replayGain → analyser` tap that `FullscreenVisualizer.tsx:199` already paints).

### 1.6 Errors + edge cases

| Symptom | Cause | Response |
|---|---|---|
| `NotAllowedError` | Permission denied at OS/Electron level | Toast: `"Mic/line-in blocked. Check OS privacy settings."` Disable Live Input UI. |
| `NotFoundError` | Device disappeared between enumerate + open | Re-enumerate, prompt user to pick again. |
| `OverconstrainedError` | `sampleRate` / `channelCount` exact constraints unsatisfiable | Retry without optional constraints. We currently only pass them as hints (`channelCount: number` not `{exact}`), so this should not happen — defensive only. |
| Empty `getAudioTracks()` | Driver glitch | Toast: `"No audio track on device."` |
| `track.ended` during session | Unplug | Engine auto-stops. UI toast. |

### 1.7 Smoke — `scripts/live-input-smoke.mjs`

1. Launch Electron with `NEWAMP_LIVE_INPUT_SMOKE=1` and a renderer flag that:
   - Builds a synthetic `MediaStream` from an `OscillatorNode → MediaStreamAudioDestinationNode` at 440 Hz + 120 BPM kick.
   - Calls `engine.attachLiveInput(stream)`.
   - Runs 60 reactor frames.
2. Assert `EvilandFrame.energy > 0` and `frame.onsets.length > 0` over the window.
3. Call `engine.stopLiveInput()`; assert `liveSource === null` and tracks are `'ended'`.
4. Wire as `npm run smoke:live-input`.

---

## 2. Detached / undocked visualizer window (priority)

### 2.1 Architecture

Two processes share one fact: the audio graph + reactor live in the **main renderer**. The detached window is intentionally dumb — one canvas, one `createEvilandRenderer`, one message-port consumer.

```
+------------------+                      +------------------+
| MAIN RENDERER    |  MessageChannelMain  | DETACHED RENDERER|
| - AudioEngine    |  port1  <=========>  port2              |
| - Reactor        |  EvilandFrame 60/s   | - 1x canvas      |
| - FrameBus       |  EvilandPalette      | - createEviland- |
| - localRenderer  |  config{quality,..}  |   Renderer       |
|   (optional)     |  + 'ack' backpressure| - ack each frame |
| - MediaRecorder  |                      |                  |
+--------^---------+                      +---------^--------+
         |                                          |
         | ipcMain.handle('detached-viz:*')         |
         |                                          |
         +---------- electron MAIN process ---------+
                     - BrowserWindow lifecycle
                     - MessageChannelMain pair
                     - screen.getAllDisplays()
                     - render-process-gone reaping
```

**Invariants the implementation MUST hold:**
- One reactor instance per app. The detached window never owns one.
- `EvilandFrame` is small + JSON-cloneable (~300 B/frame post-`structuredClone`).
- Frame transport is **renderer ↔ renderer** via `MessagePort`. Main never sees per-frame data.
- The main window's canvas can stop drawing while detached (saves a full GPU pass on weak hardware). User toggle to mirror.
- Detached window has NO `AudioContext`. Audio playback remains in main.

### 2.2 IPC protocol — main verbs

All verbs follow the existing `ipcMain.handle(name, ...)` + `ipcRenderer.invoke(name, ...)` pattern (`electron/main.ts:1524-1527` style).

```ts
// MAIN-PROCESS API (electron/main.ts additions)

// Display enumeration
ipcMain.handle('detached-viz:list-displays', () => DetachedDisplay[]);
// Returns: Array<{
//   id: number;
//   label: string;
//   bounds: { x: number; y: number; width: number; height: number };
//   workArea: { x: number; y: number; width: number; height: number };
//   scaleFactor: number;
//   internal: boolean;
//   primary: boolean;
// }>

// Window lifecycle
ipcMain.handle('detached-viz:open',  (_e, opts: { displayId?: number; fullscreen?: boolean }) => void);
ipcMain.handle('detached-viz:close', () => void);
ipcMain.handle('detached-viz:move-to-display', (_e, displayId: number) => void);
ipcMain.handle('detached-viz:set-fullscreen', (_e, on: boolean) => void);
ipcMain.handle('detached-viz:is-open', () => boolean);

// Events pushed FROM main TO main-renderer
webContents.send('detached-viz:opened');            // emitted after ready-to-show + port pair wired
webContents.send('detached-viz:closed');            // emitted from BrowserWindow 'closed'
webContents.send('detached-viz:crashed');           // emitted from 'render-process-gone'; auto-respawn or surface to user
webContents.send('displays:changed');               // emitted from screen 'display-added' / 'display-removed'

// Frame port hand-off (NOT a normal ipcMain.handle — uses webContents.postMessage)
//   After both windows are ready-to-show, main creates a MessageChannelMain pair:
//     const { port1, port2 } = new MessageChannelMain();
//     mainWin.webContents.postMessage('eviland:frame-port', null, [port1]);
//     detachedWin.webContents.postMessage('eviland:frame-port', null, [port2]);
//   Renderers receive the port in event.ports[0] (DOM MessagePort).
```

### 2.3 Main-process window factory

Insertion point: directly after the `createWindow()` function (~line 486) in `electron/main.ts`. Reuses the same `preload.js`, the same `tabWindows`-style cleanup pattern, and the same `attachWindowDiagnostics` instrumentation.

```ts
// electron/main.ts — sketch
let detachedVizWin: BrowserWindow | null = null;

function pickDisplay(displayId?: number): Electron.Display {
  const all = screen.getAllDisplays();
  if (displayId !== undefined) {
    const match = all.find((d) => d.id === displayId);
    if (match) return match;
  }
  const primary = screen.getPrimaryDisplay();
  // Default: first non-primary display, falling back to primary.
  return all.find((d) => d.id !== primary.id) ?? primary;
}

function openDetachedVisualizer(opts: { displayId?: number; fullscreen?: boolean } = {}): void {
  if (detachedVizWin && !detachedVizWin.isDestroyed()) {
    detachedVizWin.focus();
    return;
  }
  if (!mainWin) return;

  const target = pickDisplay(opts.displayId);

  detachedVizWin = new BrowserWindow({
    x: target.bounds.x + 40,
    y: target.bounds.y + 40,
    width: Math.min(1280, target.bounds.width - 80),
    height: Math.min(720,  target.bounds.height - 80),
    frame: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'NewAmp — Eviland',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,   // CRITICAL — projector display loses focus, must NOT throttle
    },
  });
  attachWindowDiagnostics(detachedVizWin, 'detached-viz');

  detachedVizWin.on('closed', () => {
    detachedVizWin = null;
    mainWin?.webContents.send('detached-viz:closed');
  });

  detachedVizWin.webContents.on('render-process-gone', (_e, details) => {
    mainWin?.webContents.send('detached-viz:crashed', { reason: details.reason });
    // Auto-reap. User can re-open from the popover. Resilience policy TBD.
  });

  if (isDev) {
    void detachedVizWin.loadURL('http://localhost:5173/detached.html');
  } else {
    void detachedVizWin.loadURL('newamp-app://app/detached.html');
  }

  detachedVizWin.once('ready-to-show', () => {
    if (!detachedVizWin || detachedVizWin.isDestroyed()) return;
    detachedVizWin.show();
    if (opts.fullscreen) detachedVizWin.setFullScreen(true);

    // Wire the port pair AFTER both renderers are ready to receive postMessage.
    const { port1, port2 } = new MessageChannelMain();
    mainWin?.webContents.postMessage('eviland:frame-port', null, [port1]);
    detachedVizWin.webContents.postMessage('eviland:frame-port', null, [port2]);

    mainWin?.webContents.send('detached-viz:opened');
  });
}

screen.on('display-added',   () => mainWin?.webContents.send('displays:changed'));
screen.on('display-removed', (_e, removed) => {
  mainWin?.webContents.send('displays:changed');
  // If the detached window lived on the removed display, move it home.
  if (!detachedVizWin || detachedVizWin.isDestroyed()) return;
  const winDisplay = screen.getDisplayMatching(detachedVizWin.getBounds());
  if (winDisplay.id === removed.id) {
    const fb = screen.getPrimaryDisplay();
    detachedVizWin.setFullScreen(false);
    detachedVizWin.setBounds({
      x: fb.bounds.x + 40, y: fb.bounds.y + 40, width: 1280, height: 720,
    });
  }
});
```

### 2.4 Preload bridge — `electron/preload.ts` (EDIT)

Append a `detachedViz` namespace next to `winctl`. Also add the port bridge — `event.ports` only survives if a preload handler re-dispatches it onto the renderer's window object.

```ts
// electron/preload.ts — additions
interface DetachedDisplay {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  internal: boolean;
  primary: boolean;
}

contextBridge.exposeInMainWorld('detachedViz', {
  listDisplays: (): Promise<DetachedDisplay[]> =>
    ipcRenderer.invoke('detached-viz:list-displays') as Promise<DetachedDisplay[]>,
  open: (opts: { displayId?: number; fullscreen?: boolean } = {}): Promise<void> =>
    ipcRenderer.invoke('detached-viz:open', opts) as Promise<void>,
  close: (): Promise<void> =>
    ipcRenderer.invoke('detached-viz:close') as Promise<void>,
  moveToDisplay: (displayId: number): Promise<void> =>
    ipcRenderer.invoke('detached-viz:move-to-display', displayId) as Promise<void>,
  setFullscreen: (on: boolean): Promise<void> =>
    ipcRenderer.invoke('detached-viz:set-fullscreen', on) as Promise<void>,
  isOpen: (): Promise<boolean> =>
    ipcRenderer.invoke('detached-viz:is-open') as Promise<boolean>,
  onOpened: (cb: () => void): (() => void) => {
    const h = () => cb();
    ipcRenderer.on('detached-viz:opened', h);
    return () => ipcRenderer.off('detached-viz:opened', h);
  },
  onClosed: (cb: () => void): (() => void) => {
    const h = () => cb();
    ipcRenderer.on('detached-viz:closed', h);
    return () => ipcRenderer.off('detached-viz:closed', h);
  },
  onCrashed: (cb: (reason: string) => void): (() => void) => {
    const h = (_e: unknown, info: { reason: string }) => cb(info.reason);
    ipcRenderer.on('detached-viz:crashed', h);
    return () => ipcRenderer.off('detached-viz:crashed', h);
  },
  onDisplaysChanged: (cb: () => void): (() => void) => {
    const h = () => cb();
    ipcRenderer.on('displays:changed', h);
    return () => ipcRenderer.off('displays:changed', h);
  },
});

// Frame-port bridge — runs in BOTH main renderer and detached renderer.
// event.ports[0] is a DOM MessagePort (NOT MessagePortMain — that's main-side).
ipcRenderer.on('eviland:frame-port', (event) => {
  window.dispatchEvent(new MessageEvent('eviland:frame-port', { ports: event.ports as MessagePort[] }));
});
```

TypeScript declarations for `window.detachedViz` belong in `src/types/global.d.ts` (or wherever `window.winctl` is declared today — extend the existing file, do not create a new ambient module).

### 2.5 Frame transport contract

Per-frame payload sent over the `MessagePort`:

```ts
// shared between main renderer producer and detached renderer consumer
import type { EvilandFrame } from '../visualizer/eviland-audio';
import type { EvilandPalette } from '../visualizer/eviland';

export interface DetachedFramePayload {
  /** performance.now() at send time, used for ACK round-trip + drift detection. */
  t: number;
  /** The reactor frame. NOTE: pooled — see §2.5.1 cloning rule. */
  frame: EvilandFrame;
  /** Current palette. Sent every frame (it's 12 floats + a bg). Trivial cost. */
  palette: EvilandPalette;
  /** Delta since last send, ms. Renderer feeds this to render(). */
  dtMs: number;
  /** Sent only when changed. Compare with prev on the producer side. */
  config?: {
    quality?: 'high' | 'medium' | 'low';
    /** Future: randomizer / director hooks. */
    operatorSeed?: string;
    directorState?: unknown;
  };
}

export interface DetachedAckPayload {
  type: 'ack';
  /** Echoes the matching DetachedFramePayload.t. */
  t: number;
}
```

#### 2.5.1 Cloning rule (load-bearing)

`EvilandFrame.bands` is a reused `Float32Array`. `EvilandFrame.onsets[]` reuses pooled objects. `structuredClone` (the algorithm `postMessage` uses) deep-copies these, so on the wire each frame is a snapshot — **but** if any code path holds a reference to the producer's frame across `postMessage` calls, that reference will mutate underfoot.

Producer rule: pass the frame **directly** into `port.postMessage(payload)`. Do not stash references. Do not transfer ownership via the `[transfer]` argument list (we want the producer to keep its frame).

#### 2.5.2 Backpressure

Default policy: **drop newest if detached is behind**. Reasoning: a stuck detached window must never block the main UI's rAF loop.

```ts
// Inside the FrameBus producer
const MAX_INFLIGHT = 3;  // ~50ms at 60Hz — tune for projector latency
let inflight = 0;

function publishToDetached(payload: DetachedFramePayload): void {
  if (inflight >= MAX_INFLIGHT) return;  // drop
  inflight++;
  port.postMessage(payload);
}

// ACK from detached consumer
port.onmessage = (msg) => {
  if ((msg.data as DetachedAckPayload)?.type === 'ack') {
    inflight = Math.max(0, inflight - 1);
  }
};
```

This converges naturally: a 60 Hz producer + 30 Hz projector settles at one dropped frame in two; we never fall more than `MAX_INFLIGHT` frames behind.

### 2.6 `src/visualizer/frame-bus.ts` (NEW)

Singleton fan-out: takes a frame from the reactor and broadcasts it to (a) the optional local renderer subscriber, and (b) the detached IPC port. Lets the main renderer stop drawing locally when the detached window is the only consumer.

```ts
// src/visualizer/frame-bus.ts
import type { EvilandFrame } from './eviland-audio';
import type { EvilandPalette } from './eviland';

export type EvilandFrameListener =
  (frame: EvilandFrame, palette: EvilandPalette, dtMs: number) => void;

export interface FrameBus {
  /** Local renderer subscribes here. Returns unsubscribe. */
  subscribe(fn: EvilandFrameListener): () => void;

  /** Called once per frame by the Visualizer rAF loop. */
  publish(frame: EvilandFrame, palette: EvilandPalette, dtMs: number): void;

  /** True when the detached window has an active port. */
  hasDetachedConsumer(): boolean;

  /** Lets UI react to detached attach/detach for "skip local draw" logic. */
  onConsumerChange(cb: (hasDetached: boolean) => void): () => void;

  /**
   * Called by the port-bridge listener (window 'eviland:frame-port' event).
   * The bus owns lifecycle: it sets up onmessage for ACKs, manages inflight.
   */
  attachDetachedPort(port: MessagePort): void;
  detachPort(): void;
}

/** Process-singleton bus. Idempotent on repeated import. */
export const frameBus: FrameBus;
```

**Top-level wiring** (inside `frame-bus.ts`):

```ts
// At module load — set up the port-bridge listener exactly once
window.addEventListener('eviland:frame-port', (event) => {
  const port = (event as MessageEvent).ports[0];
  if (port) frameBus.attachDetachedPort(port);
});
```

### 2.7 Producer-side refactor — `src/components/Visualizer.tsx` (EDIT)

The current eviland branch (lines 261-332 per the integration map) owns both the reactor AND the renderer. The refactor:

```ts
// Today:
const evFrame = reactor.analyze(freq, onsetFreq, leftFreq, rightFreq, dtMs, now);
renderer.render(evFrame, palette, dtMs);

// After refactor:
const evFrame = reactor.analyze(freq, onsetFreq, leftFreq, rightFreq, dtMs, now);
frameBus.publish(evFrame, palette, dtMs);   // <-- single publish point
```

A `useEffect` subscribes the local renderer to the bus:

```ts
const mirror = useDetachedMirrorEnabled();  // user toggle in popover, default OFF
useEffect(() => {
  if (!localRenderer) return;
  // If detached consumer is active and user disabled mirror, skip local draw.
  if (frameBus.hasDetachedConsumer() && !mirror) return;
  return frameBus.subscribe((frame, palette, dtMs) => {
    localRenderer.render(frame, palette, dtMs);
  });
}, [localRenderer, mirror, /* re-eval when consumer attach/detach */]);

useEffect(() => frameBus.onConsumerChange(() => forceRerender()), []);
```

**Net effect:** one reactor, one publish, two renderers in mirror mode, one renderer (detached only) when mirror is off. Re-runs of `scripts/eviland-smoke.mjs` and `scripts/eviland-capture.mjs` MUST still pass post-refactor.

### 2.8 Detached entry — `detached.html` + `src/detached/main.tsx` (NEW)

`detached.html` lives at repo root next to `index.html`:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>NewAmp — Eviland</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
    body { cursor: none; }
    canvas { display: block; width: 100vw; height: 100vh; }
    .eviland-msg { color: #fff; font: 14px monospace; padding: 16px; }
  </style>
</head>
<body>
  <canvas id="eviland-canvas"></canvas>
  <script type="module" src="/src/detached/main.tsx"></script>
</body>
</html>
```

`vite.config.ts`:

```ts
build: {
  rollupOptions: {
    input: {
      main:     resolve(__dirname, 'index.html'),
      detached: resolve(__dirname, 'detached.html'),
    },
  },
},
```

`src/detached/main.tsx` is intentionally tiny — no React, no zustand, no audio. Plain TS + canvas + renderer + message port:

```ts
// src/detached/main.tsx — full skeleton, no abridging
import { createEvilandRenderer } from '../visualizer/eviland';
import type { EvilandFrame } from '../visualizer/eviland-audio';
import type { EvilandPalette } from '../visualizer/eviland';

interface DetachedFramePayload {
  t: number;
  frame: EvilandFrame;
  palette: EvilandPalette;
  dtMs: number;
  config?: { quality?: 'high' | 'medium' | 'low' };
}

const canvas = document.getElementById('eviland-canvas') as HTMLCanvasElement;
let currentQuality: 'high' | 'medium' | 'low' = 'high';
let renderer = createEvilandRenderer(canvas, { quality: currentQuality });

if (!renderer) {
  const msg = document.createElement('div');
  msg.className = 'eviland-msg';
  msg.textContent = 'No WebGL2 float — detached visualizer needs a real GPU.';
  document.body.replaceChildren(msg);
  throw new Error('eviland: no-webgl2-in-detached-window');
}

function fitCanvas(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer!.resize(window.innerWidth, window.innerHeight, dpr);
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

window.addEventListener('eviland:frame-port', (event) => {
  const port = (event as MessageEvent).ports[0]!;
  port.onmessage = (msg) => {
    const payload = msg.data as DetachedFramePayload;
    const nextQuality = payload.config?.quality;
    if (nextQuality && nextQuality !== currentQuality) {
      renderer?.dispose();
      renderer = createEvilandRenderer(canvas, { quality: nextQuality });
      currentQuality = nextQuality;
      if (!renderer) return;
      fitCanvas();
    }
    renderer!.render(payload.frame, payload.palette, payload.dtMs);
    port.postMessage({ type: 'ack', t: payload.t });
  };
  port.start();
});

// Hide cursor after 2s idle.
let cursorTimer = 0;
window.addEventListener('mousemove', () => {
  document.body.style.cursor = '';
  window.clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => { document.body.style.cursor = 'none'; }, 2000);
});

// Esc exits fullscreen via main process (renderer cannot toggle fullscreen
// directly in Electron). Bind it via the existing winctl bridge if you wire
// preload to the detached window too (it is — same preload.js).
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' || event.key === 'F11') {
    void (window as unknown as { detachedViz?: { setFullscreen: (on: boolean) => void } })
      .detachedViz?.setFullscreen(false);
  }
});
```

### 2.9 UI controls — main renderer

In the Settings popover (`FullscreenVisualizer.tsx`), new "Detached Window" section:

```
Detached Window
  [ Pop out to: ( Primary 1920×1080 ▼ ) ]
  [ ⛶ Fullscreen on that display ] (checkbox)
  [ × Close detached window ]               (only visible when open)
  [ Mirror in main window ]                 (toggle, default OFF)
```

Wiring:
- Display list: `await window.detachedViz.listDisplays()`. Subscribe to `onDisplaysChanged` to refresh.
- Pop out: `await window.detachedViz.open({ displayId, fullscreen })`.
- Close: `await window.detachedViz.close()`.
- Mirror toggle: writes a settings key `eviland.detached.mirror` (zustand + persisted), read by `Visualizer.tsx`'s subscribe useEffect.
- `onCrashed`: toast `"Detached visualizer crashed. Reopen?"` with a button.

Optional toolbar shortcut: a "Pop out" icon button in the FullscreenVisualizer toolbar (free letter for shortcut: **O**).

### 2.10 Quirks + risks

- `backgroundThrottling: false` is **load-bearing**. Without it, Chromium throttles `requestAnimationFrame` to ~1 Hz on un-focused windows (exactly the projector case). Verify on a real second monitor before shipping.
- The detached `BrowserWindow` reuses the same `preload.js`. That gives it `window.api`, `window.winctl`, `window.detachedViz`, `window.newamp`. It MUST NOT call `engine.*` paths (no AudioContext) — keep `src/detached/main.tsx` to renderer/port code only.
- Audio always plays from the main window. The user's audio-output device choice is unaffected.
- If the user closes the main window, the detached window's `closed` event also fires (because main closing tears down the app). No special handling needed.
- If the user closes the detached window via the OS, main's `'detached-viz:closed'` listener clears state.

### 2.11 Smoke — `scripts/detached-viz-smoke.mjs`

1. Launch Electron in smoke mode with `NEWAMP_DETACHED_SMOKE=1`. In smoke mode, optionally fake `screen.getAllDisplays()` to return two displays (read `NEWAMP_FAKE_DISPLAY_COUNT`).
2. Invoke `detached-viz:open` with `{ fullscreen: false }`. Assert `BrowserWindow.getAllWindows().length === 2`.
3. Drive ~500 ms of synthetic playback (existing `scripts/eviland-smoke.mjs` already does this — reuse the harness).
4. `webContents.capturePage()` on the detached window. Assert non-black (sum of pixel byte values > threshold).
5. Invoke `detached-viz:close`. Assert window count drops to 1.
6. Re-open, then close the main window. Assert process exits cleanly (no orphan).
7. Wire as `npm run smoke:detached`.

---

## 3. Video recording

### 3.1 Module — `src/recording/live-recorder.ts` (NEW)

Renderer-only helper. Wraps `canvas.captureStream` + `MediaStreamAudioDestinationNode` + `MediaRecorder`. No NewAmp imports.

```ts
// src/recording/live-recorder.ts

export interface LiveRecordOptions {
  /** The canvas to capture. MUST be the surface createEvilandRenderer is drawing into. */
  canvas: HTMLCanvasElement;
  /** The AudioContext that owns audioSourceNode. */
  audioContext: AudioContext;
  /**
   * Tap point in the existing graph. The recorder creates a MediaStreamAudio-
   * DestinationNode and connects it to this node IN PARALLEL — does not affect
   * the speaker chain. For NewAmp: pass engine.graph.replayGain or, for live
   * input + speakers, engine.graph.masterGain.
   */
  audioSourceNode: AudioNode;
  /** 30 or 60. Default 60. The renderer's actual rAF rate caps effective fps. */
  fps?: 30 | 60;
  /** Hint. Default 12_000_000 (12 Mbps) — looks like YouTube at 1080p60. */
  videoBitsPerSecond?: number;
  /** Default 192_000. */
  audioBitsPerSecond?: number;
  /** Override mime probe order. Defaults to vp9 → vp8 → avc1 → generic webm. */
  preferredMimeType?: string;
  /** Timeslice for MediaRecorder.start(). Default 1000 ms. */
  timesliceMs?: number;
}

export interface LiveRecording {
  /** Stops the recorder and resolves with the final Blob. Idempotent. */
  stop(): Promise<Blob>;
  pause(): void;
  resume(): void;
  state(): RecordingState;
  /** mime actually picked (post-probe). */
  mimeType(): string;
  /** Total bytes received so far (for UI counter). */
  bytes(): number;
  /** Elapsed ms since start (for UI timer). */
  elapsedMs(): number;
}

export interface MimeSupport {
  preferred: string;     // first available from probe order
  all: string[];         // all candidates that returned true from isTypeSupported
}

/** Pure probe — call once on app boot to populate UI quality options. */
export function probeRecorderSupport(): MimeSupport;

/** Throws if no compatible mime is supported (impossible under modern Chromium / Electron). */
export function startLiveRecording(opts: LiveRecordOptions): LiveRecording;
```

#### 3.1.1 Mime probe order (canonical)

```ts
const PREFERRED_MIMES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=avc1,opus',
  'video/webm',
];
```

VP9 + Opus is the default. AV1 is omitted intentionally (Chromium support is patchy and CPU-heavy for live encode). H.264-in-WebM works for *recording* but not for `<video>` playback in Chromium — keep VP9 default.

#### 3.1.2 Audio tap rule

The audio track ALWAYS comes from a parallel `MediaStreamAudioDestinationNode`, never from `ctx.destination`. Connect the chosen source node to the new MSADest; do not disconnect it from masterGain. Disconnect cleanly in `stop()`:

```ts
const dest = audioContext.createMediaStreamDestination();
audioSourceNode.connect(dest);
// ...
recorder.onstop = () => {
  try { audioSourceNode.disconnect(dest); } catch { /* noop */ }
  videoTrack.stop();
  audioTrack.stop();
};
```

#### 3.1.3 Where the canvas comes from

The existing `FullscreenVisualizer.tsx:598` selects `canvas[data-newamp-visualizer-canvas]`. Keep that attribute on the eviland canvas. For the **detached window** recording case, two strategies:

1. **Mirror + record in main** (DEFAULT). When the user starts recording with the detached window open, force `mirror = true` temporarily. The main canvas draws the same frames; capture the main canvas + audio. Restore the user's previous mirror setting on stop.
2. **Capture detached via `webContents.beginFrameSubscription`** (FUTURE). Slower CPU path, lives in main, encodes via `ffmpeg-static`. Note only — defer to 3.4.

Default to (1). Surface a one-line hint in UI: `"Recording mirrors visuals to the main window."`

### 3.2 UI — `FullscreenVisualizer.tsx` (EDIT)

Replace the existing `toggleRecord` (lines 593-627) with:

```
[ ● Record ]  [ Quality: SD HD 4K ]  ⏱ 00:42  ⏺ 12.0 Mbps · vp9
```

- `●` is animated red while recording.
- Quality → `(fps, videoBitsPerSecond, target)`:
  - **SD**: 30 fps, 4 Mbps, current canvas resolution. Live recorder.
  - **HD**: 60 fps, 12 Mbps, current canvas resolution clamped to 1080p. Live recorder.
  - **4K**: routes to **offline export** (see §3.4) — disabled in v1 with `(Coming soon)` label.
- Timer: `live.elapsedMs()` updates every 250 ms via `setInterval`.
- Bytes counter: `(live.bytes() / live.elapsedMs() * 1000)` averaged Mbps.
- File save reuses existing `media:save-capture` IPC pattern (preload `saveCaptureBytes`). For takes > ~50 MB, switch to a chunked-write IPC trio (`media:start-capture-write`, `media:append-capture-chunk`, `media:finalize-capture`) to avoid materializing huge base64 strings in renderer memory.

Pseudocode:

```ts
const recording = useRef<LiveRecording | null>(null);

async function startRecord(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-newamp-visualizer-canvas]');
  if (!canvas) return;
  // If detached is open and mirror is off, temporarily force mirror.
  const wasMirror = settings.eviland.detached.mirror;
  if (await window.detachedViz.isOpen() && !wasMirror) {
    setMirror(true);
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  }
  recording.current = startLiveRecording({
    canvas,
    audioContext: engine.ctx,
    audioSourceNode: engine.graph.replayGain,
    fps: quality === 'HD' ? 60 : 30,
    videoBitsPerSecond: quality === 'HD' ? 12_000_000 : 4_000_000,
  });
}

async function stopRecord(): Promise<void> {
  const live = recording.current; if (!live) return;
  recording.current = null;
  const blob = await live.stop();
  if (forcedMirror) setMirror(wasMirror);
  await saveBlob(blob, `eviland-${trackSlug}-${Date.now()}.webm`);
}
```

### 3.3 File save reuse

The existing main-side `media:save-capture` handler accepts `{ base64, defaultName, filterName, ext }`. For the small-take path:

```ts
const dataUrl = await blobToDataUrl(blob);
const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
await window.newamp.saveCaptureBytes({
  base64,
  defaultName: `eviland-${trackSlug}-${Date.now()}`,
  filterName: 'WebM video',
  ext: 'webm',
});
```

For chunked writes (large takes), add three new IPC verbs in `electron/main.ts`:

```ts
ipcMain.handle('media:start-capture-write',  (_e, payload: { defaultName: string; ext: string }) => Promise<{ token: string } | null>);
ipcMain.handle('media:append-capture-chunk', (_e, payload: { token: string; base64: string }) => Promise<void>);
ipcMain.handle('media:finalize-capture',     (_e, payload: { token: string }) => Promise<string | null>);  // returns saved path
```

Renderer wires `recorder.ondataavailable` to call `append-capture-chunk` directly. Each chunk is independently base64-encoded — at 1-second timeslices, each chunk is ~1.5 MB at 12 Mbps which is well under any IPC limit.

### 3.4 Offline deterministic export (NOTE ONLY for v1)

Plan, not deliverable, for a follow-up doc:

1. While playing a track in the main renderer, `frameBus.subscribe(...)` writes each `EvilandFrame` + `nowMs` to a ring buffer. Disk-back to a temp file for long takes (~250 B/frame × 60 fps × 1 hr ≈ 54 MB).
2. On "Export deterministic 4K render":
   - `OffscreenCanvas(3840, 2160)` in a worker (verify WebGL2 + `EXT_color_buffer_float` in worker context; fall back to a hidden main-thread canvas if not).
   - Fresh `createEvilandRenderer` against the offscreen canvas.
   - Replay the frame log at fixed dt; for each frame `render(...)` → `convertToBlob({ type: 'image/png' })` → push PNG bytes through `ffmpeg-static` stdin:
     ```
     ffmpeg -y -framerate 60 -f image2pipe -i - \
            -i audio-bounce.wav \
            -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p \
            -c:a aac -b:a 320k -shortest \
            out.mp4
     ```
   - Audio: re-render via `OfflineAudioContext` with the same EQ/limiter chain so the export matches what the reactor reacted to.
3. Spawning ffmpeg lives in main (renderer cannot spawn). New IPC `eviland:export-video`:
   ```ts
   ipcMain.handle('eviland:export-video', (_e, payload: {
     frameLogPath: string;
     audioPath: string;
     outPath: string;
     width: number;
     height: number;
     fps: number;
     crf: number;
   }) => Promise<{ ok: boolean; warnings: string[] }>);
   ```
   `ffmpeg-static` exposes its binary path (already used by `electron/transcode.ts` — reuse that pattern). Stream progress events back via `webContents.send('eviland:export-progress', ...)`.

This path gives YouTube/Instagram/portfolio-grade output (deterministic, no dropped frames, full bitrate). The live `MediaRecorder` path is for "share this clip now" capture.

### 3.5 Errors + edge cases

| Symptom | Cause | Response |
|---|---|---|
| `pickSupportedMime` returns nothing | Theoretical, modern Chromium always supports `video/webm` | Throw; show toast `"Recording unavailable in this build."` |
| Recorder drops frames at 60 fps | GPU-bound renderer | Auto-fall-back to 30 fps in `Lite` perf tier; surface in UI tooltip |
| Disk full during chunked write | Main-side `fs.appendFile` throws | Stop recorder, surface error toast, leave partial file in temp |
| User closes window while recording | `onbeforeunload` MUST stop the recorder cleanly to flush the last chunk | Hook the existing `beforeunload` in `FullscreenVisualizer.tsx` |
| Audio + video drift on long takes (> 10 min) | Known `MediaRecorder` issue on Chromium | Note as known limitation; recommend offline export (§3.4) for long takes |

### 3.6 Smoke — `scripts/live-recorder-smoke.mjs`

1. Launch Electron with `NEWAMP_RECORD_SMOKE=1`.
2. Renderer: build a synthetic 60 Hz `OscillatorNode → MSADest` audio source.
3. Start recording for 3 seconds on the eviland canvas.
4. Stop, await blob. Assert `blob.size > 200_000` and `blob.type.startsWith('video/webm')`.
5. From the test script, spawn `ffmpeg -i out.webm` (use `ffmpeg-static`'s bundled binary), parse stderr. Assert:
   - `Stream #0:0: Video: vp9` (or `vp8` if VP9 unsupported in this Chromium build).
   - `Stream #0:1: Audio: opus`.
6. Wire as `npm run smoke:record`.

---

## 4. Permission + error handling reference

| Surface | Failure | UX |
|---|---|---|
| `getUserMedia({audio})` returns `NotAllowedError` | OS/Electron permission denied | Toast + disable Live Input UI + link to docs |
| `getUserMedia` returns `NotFoundError` | Device gone | Re-enumerate; prompt to re-pick |
| `track.ended` fires on live source | Unplug | Engine auto-stops; toast `"Live input device removed."` |
| Detached window `render-process-gone` | GPU process crash | Toast `"Detached visualizer crashed. Reopen?"` with action |
| Detached window OS-closed | Normal close | Silent — UI controls update via `onClosed` |
| `MessageChannelMain` port closed early | One window unloaded before the other | Producer side: `port.onmessageerror` → `frameBus.detachPort()` |
| `MediaRecorder.onerror` | Encode failure | Stop recording, toast, leave partial file |
| Display removed while detached window lives on it | OS unplug second monitor | Auto-move-home (see `screen.on('display-removed')`) |

---

## 5. Implementation order (recommended)

1. **Permission handler** in `electron/main.ts`. 10 lines. Unblocks every `getUserMedia` call.
2. **`src/audio/live-input.ts`** + **`engine.attachLiveInput`/`stopLiveInput`/`setLiveMonitoring`** + Source/Device/Monitor UI rows. Ship + smoke.
3. **`frameBus` refactor** of `Visualizer.tsx`'s eviland branch. ZERO BEHAVIOUR CHANGE — pure plumbing. Re-run `scripts/eviland-capture.mjs` + `scripts/eviland-smoke.mjs` and visually compare the PNGs to confirm no regression.
4. **Detached window** end-to-end: main-process IPC + `detached.html` + `src/detached/main.tsx` + preload bridge + Pop Out UI. Ship + smoke (`scripts/detached-viz-smoke.mjs`).
5. **Live recorder v1**: `src/recording/live-recorder.ts` + replace `toggleRecord` + chunked-capture IPC if needed. Ship + smoke (`scripts/live-recorder-smoke.mjs`).
6. **Offline ffmpeg export** as a follow-up — bigger surface, needs its own design doc (§3.4 is the seed).

---

## 6. Non-negotiables

- Do not edit `src/visualizer/eviland.ts` shaders / passes / warp formulas as part of this work. The renderer is verified working (PNG capture + GPU smoke). All NEW capability lives in NEW files plus minimally-additive edits to `engine.ts`, `Visualizer.tsx`, `FullscreenVisualizer.tsx`, `electron/main.ts`, `electron/preload.ts`.
- One reactor instance per app. The detached window owns only a renderer + port consumer.
- Live audio source MUST NOT reach `ctx.destination` by default (feedback). `setLiveMonitoring(true)` is opt-in with a UI warning.
- `EvilandFrame` is the IPC contract. Never send raw FFT byte arrays across windows.
- `backgroundThrottling: false` on the detached `BrowserWindow` is load-bearing — without it, `requestAnimationFrame` drops to ~1 Hz when the projector display loses focus.
- After steps 3-5 ship: `scripts/eviland-capture.mjs` PNG and `scripts/eviland-smoke.mjs` reactivity MUST still pass. `npm run typecheck` clean.
- ES modules everywhere — `import`/`export`. No `require`.
