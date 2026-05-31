# Eviland — Live I/O Implementation Spec

> Live audio input (mic / line-in / audio interface) + detached visualizer window
> on a second display + canvas-with-audio video recording.
>
> Verified against current docs 2026-05-30. Electron 42, Chromium ~134.
> Anchored to actual NewAmp source in `src/audio/engine.ts`, `src/visualizer/`,
> `src/components/Visualizer.tsx`, `src/components/FullscreenVisualizer.tsx`,
> `electron/main.ts`, `electron/preload.ts`.

---

## 0. Architecture Summary

Three orthogonal capabilities. They share one fact: the audio graph + reactor live in the **main renderer**. Everything else fans out from there.

```
                +------------------------+
                |  electron MAIN process |
                |  - permission handlers |
                |  - BrowserWindow mgmt  |
                |  - MessageChannelMain  |
                |  - ffmpeg-static exec  |
                +-----------+------------+
                            |
                  IPC + MessagePortMain
                            |
       +--------------------+--------------------+
       |                                         |
+------v-----------+                     +-------v---------+
|  MAIN RENDERER   |                     | DETACHED VIZ    |
|  (NewAmp UI)     |   ====frames====>   | RENDERER        |
|                  |   MessagePort 60fps |  (thin)         |
|  AudioEngine     |                     |                 |
|   - 2x decks     |                     |  - canvas       |
|   - EQ/limiter   |                     |  - createEviland|
|   - 4x analysers |                     |    Renderer     |
|   - liveInput    |                     |  - applies palette
|   - MSADestNode  |                     |    + frame      |
|  + EvilandReactor|                     |                 |
|  + EvilandRenderer (mirror, optional)  |                 |
|  + MediaRecorder (canvas + MSADest)    |                 |
+------------------+                     +-----------------+
```

Key invariant: **`EvilandFrame` is small and JSON-serializable** (24 floats + a
handful of scalars + at most ~6 onset objects). Sending it 60 times per second
over `MessagePortMain` is well within `structuredClone` throughput. We do **not**
send raw FFT byte arrays over IPC.

---

## 1. LIVE AUDIO INPUT

### 1.1 Goal

Let the user pick any installed audio input (USB mic, line-in, audio interface,
loopback device like VB-Cable / BlackHole) and feed it into the existing
`AudioEngine` graph so the Eviland reactor and recorder see the same signal as
file playback. **Music-grade**: no echo cancellation, no AGC, no noise
suppression — those mutilate music.

### 1.2 Electron permission handler (MAIN, mandatory)

Without this, `getUserMedia({audio})` from `file://` / `newamp-app://` origins
**fails silently** with `NotAllowedError`. Currently no handler exists in
`electron/main.ts` (verified by grep) so this MUST be added.

Per the current docs there is **no separate `audioCapture` permission string**:
Electron uses the unified `'media'` permission with a `mediaType` discriminator
on the `details` object (`'audio'` | `'video'` | `'unknown'`).

Add **once**, immediately after `app.whenReady()` in `electron/main.ts`, before
`createWindow()`:

```ts
import { session } from 'electron';

function registerMediaPermissions(): void {
  const ses = session.defaultSession;

  // Used when the page calls getUserMedia / enumerateDevices.
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === 'media') {
      // details.mediaTypes is an array in current Electron; older builds use mediaType.
      const types: string[] = (details as { mediaTypes?: string[]; mediaType?: string }).mediaTypes
        ?? (details as { mediaType?: string }).mediaType
          ? [(details as { mediaType: string }).mediaType]
          : [];
      // Only audio — we never request video.
      if (!types.length || types.includes('audio')) return callback(true);
      return callback(false);
    }
    callback(false);
  });

  // Required by Chromium for synchronous permission checks (e.g. before
  // enumerateDevices reveals device labels).
  ses.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    if (permission === 'media') {
      const t = (details as { mediaType?: string }).mediaType;
      return !t || t === 'audio' || t === 'unknown';
    }
    return false;
  });

  // Belt-and-suspenders for asynchronous device enumeration in newer Chromium.
  ses.setDevicePermissionHandler(() => false); // HID/serial/USB stay denied.
}
```

Call from `app.whenReady().then(...)` exactly once.

**Verification:** the existing `Visualizer-only` route currently has `webPreferences.sandbox: false`, `webSecurity: true`, `contextIsolation: true` — these are compatible with `mediaDevices.getUserMedia`. Do not change them.

### 1.3 Device enumeration (RENDERER)

The settings view already partially enumerates output devices
(`src/components/views/SettingsView.tsx:181`). Mirror that for inputs.

```ts
export interface AudioInputDevice {
  deviceId: string;
  label: string;
  groupId: string;
}

export async function listAudioInputDevices(): Promise<AudioInputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  // CRITICAL: labels are empty until permission is granted. Do a no-op getUserMedia
  // first IF the user has never granted; otherwise enumerate directly.
  let devices = await navigator.mediaDevices.enumerateDevices();
  const haveLabels = devices.some((d) => d.kind === 'audioinput' && d.label);
  if (!haveLabels) {
    let probe: MediaStream | null = null;
    try {
      probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      // User denied. Return device IDs without labels — usable, just unlabeled.
    } finally {
      probe?.getTracks().forEach((t) => t.stop());
    }
  }
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Audio input', groupId: d.groupId }));
}

// Hot-plug: the spec event is `devicechange` on navigator.mediaDevices.
export function watchDeviceChanges(onChange: () => void): () => void {
  if (!navigator.mediaDevices?.addEventListener) return () => {};
  navigator.mediaDevices.addEventListener('devicechange', onChange);
  return () => navigator.mediaDevices.removeEventListener('devicechange', onChange);
}
```

### 1.4 Music-grade constraints (RENDERER)

The single most important rule. Default Chrome voice processing destroys music
(AGC pumps, noise gate eats sustain, AEC notches the spectrum). All three MUST
be `false`. The `googXxx`-prefixed legacy constraints are ignored in current
Chromium and should not be sent.

```ts
export interface OpenLiveInputOptions {
  deviceId?: string;            // exact device, or omit for system default
  channelCount?: 1 | 2;         // 2 for stereo interfaces
  sampleRate?: number;          // hint only; AudioContext resamples anyway
  preferLowLatency?: boolean;   // toggles latencyHint hint, not the constraint
}

export async function openLiveInputStream(opts: OpenLiveInputOptions = {}): Promise<MediaStream> {
  const audio: MediaTrackConstraints = {
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false,
    // Optional — Chromium honors these as hints, not hard requirements.
    channelCount: opts.channelCount ?? 2,
  };
  if (opts.deviceId) audio.deviceId = { exact: opts.deviceId };
  if (opts.sampleRate) audio.sampleRate = { ideal: opts.sampleRate };
  return navigator.mediaDevices.getUserMedia({ audio, video: false });
}
```

Track the actual settings after acquisition (useful for the "this interface is
locked to 44.1k" UI): `stream.getAudioTracks()[0].getSettings()`.

### 1.5 Graft into the existing graph (`src/audio/engine.ts`)

The graph today is (verified, lines 256-272):

```
deck0,1 → inputGain → eq[10] → replayGain ─┬─→ masterGain → limiter → destination
                                            ├─→ analyser
                                            ├─→ onsetAnalyser
                                            └─→ stereoSplitter → {left,right}Analyser
```

Live input must **replace the deck contribution** (it is its own source — file
playback is paused while live input is active) but reuse everything from
`inputGain` onward, so the reactor, recorder, EQ, limiter, and volume control
all work unchanged.

Add to `AudioEngine`:

```ts
private liveSource: MediaStreamAudioSourceNode | null = null;
private liveStream: MediaStream | null = null;
private liveActive = false;

/** Returns true if live input is currently feeding the graph. */
isLiveInputActive(): boolean {
  return this.liveActive;
}

/**
 * Mount a live MediaStream into the graph. Both decks are paused and muted
 * for the duration; calling stopLiveInput() restores the previous deck state.
 */
attachLiveInput(stream: MediaStream): void {
  const graph = this.ensureGraph();
  this.detachLiveInputInternal();

  // Pause file playback so the user does not hear both at once.
  for (const deck of graph.decks) {
    try { deck.el.pause(); } catch { /* noop */ }
    deck.gain.gain.cancelScheduledValues(graph.ctx.currentTime);
    deck.gain.gain.setValueAtTime(0, graph.ctx.currentTime);
  }

  const source = graph.ctx.createMediaStreamSource(stream);
  // CRITICAL: do NOT connect the live source to graph.ctx.destination directly,
  // and do NOT route it through masterGain → limiter → destination. Connecting
  // a microphone to the same destination as the speakers it can hear causes
  // a feedback loop. We connect ONLY to the analyser bus so visualizers see it
  // and the recorder (MediaStreamAudioDestinationNode below) hears it.
  //
  // If the user explicitly wants to MONITOR (headphones only — DAW pattern),
  // setLiveMonitoring(true) connects through masterGain. UI must warn.
  source.connect(graph.analyser);
  source.connect(graph.onsetAnalyser);
  source.connect(graph.stereoSplitter);

  this.liveSource = source;
  this.liveStream = stream;
  this.liveActive = true;

  // Auto-cleanup when the user revokes the device or unplugs the interface.
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => this.stopLiveInput());
  }

  this.notify();
}

/** True = monitor live input through master/limiter to speakers. WARN about feedback. */
setLiveMonitoring(on: boolean): void {
  if (!this.graph || !this.liveSource) return;
  try { this.liveSource.disconnect(this.graph.masterGain); } catch { /* not connected */ }
  if (on) this.liveSource.connect(this.graph.masterGain);
}

stopLiveInput(): void {
  this.detachLiveInputInternal();
  this.notify();
}

private detachLiveInputInternal(): void {
  if (this.liveSource) {
    try { this.liveSource.disconnect(); } catch { /* noop */ }
    this.liveSource = null;
  }
  if (this.liveStream) {
    for (const t of this.liveStream.getTracks()) t.stop();
    this.liveStream = null;
  }
  this.liveActive = false;
}
```

**Why not connect the live source to `inputGain`?** `inputGain` feeds EQ +
masterGain + limiter + destination. The user does not generally want their
guitar/mic going to the speakers (feedback) and they do not want the player's
master volume to affect their interface signal. Reactor + recorder only.
Monitoring is opt-in and gated behind a UI warning.

**Sample rate:** verified in MDN — `MediaStreamAudioSourceNode` automatically
resamples to the `AudioContext`'s rate. NewAmp already supports a preferred
sample rate (`setPreferredSampleRate`) and creates the context lazily. Live
input works regardless; the analyser/reactor pipeline is rate-agnostic
(`engine.getSampleRate()` is read each remount by `Visualizer.tsx:289`).

### 1.6 UI / wiring

Add a **Source** segmented control to the visualizer Settings popover and the
Live page (when we add it):

```
Source: ( File ) ( Live Input )    Device: [USB Audio Codec ▼]    [Monitor: off]
```

- `File` re-enables decks (call `engine.stopLiveInput()` and the next `play()`
  unmutes deck gain automatically through the existing crossfade/play path).
- `Live Input` opens the device picker → `openLiveInputStream` →
  `engine.attachLiveInput(stream)`. Refresh device list on `devicechange`.
- When `liveActive`, hide track/transport UI and show an animated input-level
  meter (use the existing `replayGain` -> analyser tap; the level meter span
  already exists in `FullscreenVisualizer.tsx:199`).

### 1.7 Hot-plug behavior

- `devicechange` fires when any audio device is added/removed. Re-enumerate.
- If the active live device disappears mid-session, the `track.ended` handler
  added in `attachLiveInput` calls `stopLiveInput` automatically. UI surfaces a
  toast: `"Live input device removed."`

### 1.8 Smoke

New script `scripts/live-input-smoke.mjs` that:
1. Launches Electron with `--newamp-live-input-smoke=1`.
2. Renderer side: mocks `navigator.mediaDevices.getUserMedia` to return a
   `MediaStreamTrackGenerator`-backed synthetic stream (or a constant
   `OscillatorNode → MediaStreamDestination` generated stream).
3. Calls `engine.attachLiveInput`, runs 30 reactor frames, asserts
   `EvilandFrame.energy > 0` and at least one onset fires.
4. Calls `engine.stopLiveInput()`, asserts `liveSource === null` and
   `getAudioTracks().every(t => t.readyState === 'ended')`.

---

## 2. DETACHED / UNDOCKED VISUALIZER WINDOW

> Priority. The user can drag the visualizer onto a projector / second monitor,
> fullscreen it there, and keep browsing NewAmp on the primary display.

### 2.1 Two-process model

| Process | Owns | Does not own |
|---|---|---|
| **Main renderer** (existing) | `AudioContext`, decks, EQ, limiter, **EvilandReactor**, library UI, MediaRecorder | rendering on the detached canvas |
| **Detached renderer** (new) | one `<canvas>`, `createEvilandRenderer`, frame consumer | audio, reactor, library, state |
| **Main process** | `BrowserWindow`, display selection, `MessageChannelMain` | both renderers' state |

The detached window is intentionally **stateless and dumb**: it boots, opens
its IPC port, waits for `{frame, palette, config}` messages, and calls
`renderer.render(frame, palette, dtMs)`. If the main window goes away, the
detached window blanks and closes. There is exactly one frame producer.

### 2.2 IPC choice — `MessageChannelMain`, not `ipcMain.send`

Three reasons to use `MessageChannelMain`:

1. **Direct port between renderers.** `ipcMain.send` routes through main, which
   adds a hop. With `MessageChannelMain` we mint a pair in main, give port1 to
   the main renderer and port2 to the detached renderer; messages then travel
   renderer↔renderer with no main-process work per frame.
2. **No `'channel'` string per message.** Less overhead than `ipcRenderer.send`.
3. **Backpressure-friendly.** We can attach `onmessage` on port2 and the main
   renderer reads `onmessage` ACKs on port1 to know the detached side is keeping
   up.

Verified shape from current Electron docs:

```ts
// MAIN
import { MessageChannelMain } from 'electron';
const { port1, port2 } = new MessageChannelMain();
mainWin.webContents.postMessage('eviland:port', null, [port1]);
detachedWin.webContents.postMessage('eviland:port', null, [port2]);
```

```ts
// PRELOAD (both windows) — must expose port reception to renderer
ipcRenderer.on('eviland:port', (event) => {
  // event.ports[0] is a MessagePort in the renderer (DOM type, not MessagePortMain)
  window.dispatchEvent(new MessageEvent('eviland:port', { ports: event.ports }));
});
```

```ts
// RENDERER
window.addEventListener('eviland:port', (e: MessageEvent) => {
  const port = e.ports[0]!;
  port.onmessage = (msg) => handleFrame(msg.data);
  port.start();
});
```

### 2.3 What to send per frame — `EvilandFrame`, not raw FFT

`EvilandFrame` (defined `src/visualizer/eviland-audio.ts:28`) is:
- `bands: Float32Array(24)` → 96 bytes
- 9 scalars (`kick`, `bass`, `snare`, `hat`, `vocal`, `energy`, `centroid`, `flatness`, `crest`)
- 6 more scalars (`rolloff`, `width`, `pan`, `beatPhase`, `beatConfidence`, `bpm`, `novelty`, `sectionId`, `sectionChanged`, `sectionReturn`)
- `onsets: EvilandOnset[]` → typically 0-4 per frame, each 4 numbers

Total ≈ 200-300 bytes/frame post-`structuredClone`, well under IPC limits.

Per-frame **payload**:

```ts
interface DetachedFramePayload {
  t: number;                      // performance.now() at send
  frame: EvilandFrame;            // the reactor frame
  palette: EvilandPalette;        // {accent, dark, light, bg} as 3-tuples
  dtMs: number;                   // delta for renderer's warp math
  // Sent only when changed (compare with prev):
  config?: {
    quality: 'high' | 'medium' | 'low';
    operatorSeed?: string;        // future randomizer
    directorState?: unknown;      // future Director output
  };
}
```

**Do NOT** send `freq` / `onsetFreq` / `leftFreq` / `rightFreq` raw byte arrays
(8KB+/frame × 60fps = 480 KB/s of `structuredClone` work for zero benefit — the
reactor already consumed them).

### 2.4 Backpressure

Default policy: **drop newest if detached side is behind**. Reasoning: a stuck
detached window must never block file playback or the main UI loop. The main
renderer ticks a tiny inflight counter:

```ts
// MAIN RENDERER frame producer (runs inside the existing rAF loop in Visualizer.tsx)
let inflight = 0;
const MAX_INFLIGHT = 3; // 50ms worth at 60fps; tune for projector latency

function sendFrame(payload: DetachedFramePayload): void {
  if (inflight >= MAX_INFLIGHT) return;          // drop
  inflight++;
  port.postMessage(payload);
}

// DETACHED RENDERER ACKs after each render
port.onmessage = (msg) => {
  const payload = msg.data as DetachedFramePayload;
  renderer.render(payload.frame, payload.palette, payload.dtMs);
  port.postMessage({ type: 'ack', t: payload.t });
};

// MAIN RENDERER hears ACK
port.onmessage = (msg) => {
  if (msg.data?.type === 'ack') inflight = Math.max(0, inflight - 1);
};
```

This converges naturally: a 60Hz main + 30Hz projector settles at one dropped
frame in two; the renderer never falls more than `MAX_INFLIGHT` frames behind.

### 2.5 Main process — window lifecycle

Add to `electron/main.ts`:

```ts
let detachedVizWin: BrowserWindow | null = null;
let detachedPortPair: { mainPort: Electron.MessagePortMain; detachedPort: Electron.MessagePortMain } | null = null;

function openDetachedVisualizer(opts: { displayId?: number; fullscreen?: boolean }): void {
  if (detachedVizWin && !detachedVizWin.isDestroyed()) {
    detachedVizWin.focus();
    return;
  }
  if (!mainWin) return;

  const targetDisplay = pickDisplay(opts.displayId);
  detachedVizWin = new BrowserWindow({
    x: targetDisplay.bounds.x + 40,
    y: targetDisplay.bounds.y + 40,
    width: Math.min(1280, targetDisplay.bounds.width - 80),
    height: Math.min(720, targetDisplay.bounds.height - 80),
    frame: false,
    backgroundColor: '#000000',
    title: 'NewAmp — Eviland',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // CRITICAL: do not throttle the projector
    },
  });
  attachWindowDiagnostics(detachedVizWin, 'detached-viz');

  detachedVizWin.on('closed', () => {
    detachedVizWin = null;
    if (detachedPortPair) {
      try { detachedPortPair.mainPort.close(); } catch { /* noop */ }
      try { detachedPortPair.detachedPort.close(); } catch { /* noop */ }
      detachedPortPair = null;
    }
    mainWin?.webContents.send('detached-viz:closed');
  });

  // Load a dedicated route. In dev, vite serves /detached.html; in prod,
  // newamp-app://app/detached.html is served by the existing protocol handler.
  if (isDev) {
    void detachedVizWin.loadURL('http://localhost:5173/detached.html');
  } else {
    void detachedVizWin.loadURL('newamp-app://app/detached.html');
  }

  detachedVizWin.once('ready-to-show', () => {
    detachedVizWin?.show();
    if (opts.fullscreen) detachedVizWin?.setFullScreen(true);

    // Wire the port pair AFTER both windows can receive postMessage.
    const { port1, port2 } = new MessageChannelMain();
    detachedPortPair = { mainPort: port1, detachedPort: port2 };
    mainWin?.webContents.postMessage('eviland:frame-port', null, [port1]);
    detachedVizWin?.webContents.postMessage('eviland:frame-port', null, [port2]);
  });
}

function pickDisplay(displayId?: number): Electron.Display {
  const all = screen.getAllDisplays();
  if (displayId) {
    const match = all.find((d) => d.id === displayId);
    if (match) return match;
  }
  // Default: pick the first non-primary display, falling back to primary.
  const primary = screen.getPrimaryDisplay();
  return all.find((d) => d.id !== primary.id) ?? primary;
}

screen.on('display-added', () => mainWin?.webContents.send('displays:changed'));
screen.on('display-removed', (_e, removed) => {
  mainWin?.webContents.send('displays:changed');
  // If the detached window lived on the removed display, move it home.
  if (!detachedVizWin || detachedVizWin.isDestroyed()) return;
  const winDisplay = screen.getDisplayMatching(detachedVizWin.getBounds());
  if (winDisplay.id === removed.id) {
    const fallback = screen.getPrimaryDisplay();
    detachedVizWin.setBounds({
      x: fallback.bounds.x + 40, y: fallback.bounds.y + 40,
      width: 1280, height: 720,
    });
    detachedVizWin.setFullScreen(false);
  }
});

ipcMain.handle('detached-viz:open', (_e, opts) => openDetachedVisualizer(opts ?? {}));
ipcMain.handle('detached-viz:close', () => {
  if (detachedVizWin && !detachedVizWin.isDestroyed()) detachedVizWin.close();
});
ipcMain.handle('detached-viz:move-to-display', (_e, displayId: number) => {
  if (!detachedVizWin || detachedVizWin.isDestroyed()) return;
  const target = pickDisplay(displayId);
  const wasFs = detachedVizWin.isFullScreen();
  if (wasFs) detachedVizWin.setFullScreen(false);
  detachedVizWin.setBounds({
    x: target.bounds.x + 40, y: target.bounds.y + 40,
    width: Math.min(1280, target.bounds.width - 80),
    height: Math.min(720, target.bounds.height - 80),
  });
  if (wasFs) detachedVizWin.setFullScreen(true);
});
ipcMain.handle('detached-viz:set-fullscreen', (_e, on: boolean) => {
  detachedVizWin?.setFullScreen(!!on);
});
ipcMain.handle('detached-viz:list-displays', () =>
  screen.getAllDisplays().map((d) => ({
    id: d.id, label: d.label, bounds: d.bounds, workArea: d.workArea,
    scaleFactor: d.scaleFactor, internal: d.internal, primary: d.id === screen.getPrimaryDisplay().id,
  })),
);
```

### 2.6 Preload additions (`electron/preload.ts`)

Expose detached-viz controls + the port-reception bridge:

```ts
contextBridge.exposeInMainWorld('detachedViz', {
  open: (opts: { displayId?: number; fullscreen?: boolean } = {}) =>
    ipcRenderer.invoke('detached-viz:open', opts),
  close: () => ipcRenderer.invoke('detached-viz:close'),
  moveToDisplay: (displayId: number) =>
    ipcRenderer.invoke('detached-viz:move-to-display', displayId),
  setFullscreen: (on: boolean) =>
    ipcRenderer.invoke('detached-viz:set-fullscreen', on),
  listDisplays: () =>
    ipcRenderer.invoke('detached-viz:list-displays') as Promise<DetachedDisplay[]>,
  onClosed: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('detached-viz:closed', h);
    return () => ipcRenderer.off('detached-viz:closed', h);
  },
  onDisplaysChanged: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('displays:changed', h);
    return () => ipcRenderer.off('displays:changed', h);
  },
});

// Port bridge — runs in both renderers. event.ports survives the dispatch.
ipcRenderer.on('eviland:frame-port', (event) => {
  window.dispatchEvent(new MessageEvent('eviland:frame-port', { ports: event.ports as MessagePort[] }));
});
```

### 2.7 New detached entry — `detached.html` + `src/detached/main.tsx`

`index.html` is the main app entry. Add a sibling `detached.html`:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>NewAmp — Eviland</title>
  <style>
    html,body { margin:0; padding:0; height:100%; background:#000; overflow:hidden; }
    body { cursor: none; }
    canvas { display:block; width:100vw; height:100vh; }
  </style>
</head>
<body>
  <canvas id="eviland-canvas"></canvas>
  <script type="module" src="/src/detached/main.tsx"></script>
</body>
</html>
```

Wire it in `vite.config.ts` as a second entry:

```ts
rollupOptions: {
  input: {
    main: 'index.html',
    detached: 'detached.html',
  },
}
```

`src/detached/main.tsx` — intentionally tiny:

```ts
import { createEvilandRenderer } from '../visualizer/eviland';
import type { EvilandFrame } from '../visualizer/eviland-audio';
import type { EvilandPalette } from '../visualizer/eviland';

interface DetachedFramePayload {
  t: number;
  frame: EvilandFrame;
  palette: EvilandPalette;
  dtMs: number;
  config?: { quality: 'high' | 'medium' | 'low' };
}

const canvas = document.getElementById('eviland-canvas') as HTMLCanvasElement;
let renderer = createEvilandRenderer(canvas, { quality: 'high' });
if (!renderer) {
  // Use textContent (not innerHTML) — even for static strings, keep the
  // pattern XSS-safe so it stays safe when the message becomes dynamic later.
  const msg = document.createElement('div');
  msg.setAttribute('style', 'color:#fff;font:14px monospace;padding:16px');
  msg.textContent = 'No WebGL2 float — detached visualizer needs a real GPU.';
  document.body.replaceChildren(msg);
  throw new Error('no-webgl2');
}

function fitCanvas(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer!.resize(window.innerWidth, window.innerHeight, dpr);
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

let port: MessagePort | null = null;

window.addEventListener('eviland:frame-port', (event) => {
  port = (event as MessageEvent).ports[0]!;
  port.onmessage = (msg) => {
    const payload = msg.data as DetachedFramePayload;
    if (payload?.config?.quality && payload.config.quality !== currentQuality) {
      renderer?.dispose();
      renderer = createEvilandRenderer(canvas, { quality: payload.config.quality });
      currentQuality = payload.config.quality;
      fitCanvas();
    }
    renderer!.render(payload.frame, payload.palette, payload.dtMs);
    // ACK so the main side can manage backpressure.
    port!.postMessage({ type: 'ack', t: payload.t });
  };
  port.start();
});

let currentQuality: 'high' | 'medium' | 'low' = 'high';

// Hide the cursor after 2s of inactivity in fullscreen.
let cursorTimer = 0;
window.addEventListener('mousemove', () => {
  document.body.style.cursor = '';
  window.clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => { document.body.style.cursor = 'none'; }, 2000);
});

// Esc exits fullscreen — Electron handles this natively if we ask politely.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'F11') {
    // Cannot toggle fullscreen from renderer in Electron — ask main.
    // Optional: ipcRenderer.invoke('detached-viz:set-fullscreen', false)
  }
});
```

### 2.8 Main-renderer side: producing frames

Refactor the `mode === 'eviland'` branch in `src/components/Visualizer.tsx`
(currently ~lines 261-332). Today it owns BOTH the reactor and the renderer.
Split into a singleton **reactor frame producer** that runs once per app, and an
optional **local renderer** that draws into the inline canvas.

New module `src/visualizer/frame-bus.ts`:

```ts
import type { EvilandFrame } from './eviland-audio';
import type { EvilandPalette } from './eviland';

export type EvilandFrameListener = (frame: EvilandFrame, palette: EvilandPalette, dtMs: number) => void;

class FrameBus {
  private listeners = new Set<EvilandFrameListener>();
  private port: MessagePort | null = null;
  private inflight = 0;
  private readonly MAX_INFLIGHT = 3;

  attachDetachedPort(port: MessagePort): void {
    this.port = port;
    port.onmessage = (msg) => {
      if (msg.data?.type === 'ack') this.inflight = Math.max(0, this.inflight - 1);
    };
    port.start();
  }

  detachPort(): void {
    this.port = null;
    this.inflight = 0;
  }

  subscribe(fn: EvilandFrameListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(frame: EvilandFrame, palette: EvilandPalette, dtMs: number): void {
    for (const l of this.listeners) l(frame, palette, dtMs);
    if (this.port && this.inflight < this.MAX_INFLIGHT) {
      this.inflight++;
      this.port.postMessage({ t: performance.now(), frame, palette, dtMs });
    }
  }

  hasDetachedConsumer(): boolean {
    return this.port !== null;
  }
}

export const frameBus = new FrameBus();

window.addEventListener('eviland:frame-port', (event) => {
  const port = (event as MessageEvent).ports[0];
  if (port) frameBus.attachDetachedPort(port);
});
```

In `Visualizer.tsx`'s eviland branch, replace the direct `renderer.render(...)`
call with `frameBus.publish(evFrame, palette, dtMs)`. The local renderer
subscribes through `frameBus.subscribe`. When **detached and not mirroring**,
skip the local subscription so the main window's GPU is free:

```ts
const mirror = useDetachedMirrorEnabled(); // user toggle, default off
const localRenderer = useMemo(() => createEvilandRenderer(canvas, {...}), [...]);

useEffect(() => {
  if (!localRenderer) return;
  if (frameBus.hasDetachedConsumer() && !mirror) return; // skip local draw
  return frameBus.subscribe((frame, palette, dtMs) => {
    localRenderer.render(frame, palette, dtMs);
  });
}, [localRenderer, mirror, frameBus.hasDetachedConsumer()]);
```

**Result:** the reactor runs once. The detached window always draws. The main
window's canvas draws only when there is no detached consumer, or the user
explicitly enabled `mirror`. Saves a full WebGL pass on weak hardware.

### 2.9 UI controls

In the Settings popover, add a **Detached Window** section:

- `[ Pop out to second display ▾ ]` (dropdown of displays from `detachedViz.listDisplays()`)
- `[ × Close detached window ]` (visible only when open)
- `[ ⛶ Fullscreen there ]`
- `[ Mirror in main window ]` (off by default; saves GPU)

When the user picks a display + clicks the action, call
`detachedViz.open({displayId, fullscreen: true})`. Re-listen to
`onDisplaysChanged` to refresh the dropdown.

### 2.10 Quirks + risks

- **`backgroundThrottling: false`** on the detached window — without this,
  Chromium throttles `requestAnimationFrame` to ~1 Hz when the window is on a
  display not currently focused, which is exactly the projector case. Verified
  pattern: it is already used implicitly in the main window via `webPreferences.backgroundThrottling: !smokeMode`. Keep it `false` for detached.
- **Mouse cursor on projector** — hide after idle (see above).
- **Crash recovery** — if the detached window's GPU process dies, the main
  side's `port.onmessage` simply stops receiving ACKs. The main renderer keeps
  going. The user can `Close` → `Open` again. Hook `render-process-gone` on
  `detachedVizWin.webContents` to auto-reopen if Tyler wants resilience.
- **Audio stays in main only.** The detached window has no `AudioContext`. The
  user's audio device choice (NewAmp's existing `audio-output` setting) is
  unaffected.

### 2.11 Smoke

`scripts/detached-viz-smoke.mjs`:
1. Launch Electron with two virtual displays (Playwright + Chromium has
   `--use-fake-device-for-media-stream`; for displays, set
   `process.env.NEWAMP_FAKE_DISPLAY_COUNT=2` and have main fake
   `screen.getAllDisplays()` in smoke mode).
2. Invoke `detached-viz:open`, assert `BrowserWindow.getAllWindows().length === 2`.
3. Read the detached window's canvas via `webContents.capturePage` after
   ~500ms playback of a known test track, hash, confirm non-black.
4. Close, assert clean teardown.

---

## 3. VIDEO RECORDING

### 3.1 Goal

Two ratchets:

| Mode | Use case | Tool | Quality | Realtime? |
|---|---|---|---|---|
| **Live capture** | "Grab what I just heard" | `MediaRecorder` on `canvas.captureStream` + `MSADest` | 1080p VP9, 8-20 Mbps | yes |
| **Offline render** | YouTube-quality export | `ffmpeg-static` over a recorded `EvilandFrame` log | 4K H.264, 50 Mbps | no (deterministic re-render) |

The existing implementation
(`src/components/FullscreenVisualizer.tsx:593-627`) covers a minimal **video
only** live capture at 30 fps with default bitrate and no audio. Treat that as
v0; replace.

### 3.2 Live capture v1 — canvas + audio, configurable

Build a small reusable helper `src/recording/live-recorder.ts`:

```ts
export interface LiveRecordOptions {
  canvas: HTMLCanvasElement;
  audioContext: AudioContext;
  audioSourceNode: AudioNode;        // tap point in the existing graph
  fps?: 30 | 60;
  videoBitsPerSecond?: number;       // default 12_000_000 (12 Mbps)
  audioBitsPerSecond?: number;       // default 192_000
  preferredMimeType?: string;        // probe-fallback chain handled internally
}

const PREFERRED_MIMES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=avc1,opus',
  'video/webm',
];

export interface LiveRecording {
  stop(): Promise<Blob>;
  pause(): void;
  resume(): void;
  state(): RecordingState;
}

export function startLiveRecording(opts: LiveRecordOptions): LiveRecording {
  const fps = opts.fps ?? 60;
  // captureStream MUST be called on the same canvas the WebGL renderer is
  // drawing into. For the detached window case, do recording in main renderer
  // with the local mirror enabled, OR add a recording mode that lifts ACKs and
  // reads the detached window via webContents.beginFrameSubscription (slower).
  const videoTrack = opts.canvas.captureStream(fps).getVideoTracks()[0]!;

  // Audio: parallel MSA destination off the live tap (analyser bus). This
  // does NOT add load to the speaker chain.
  const dest = opts.audioContext.createMediaStreamDestination();
  opts.audioSourceNode.connect(dest);
  const audioTrack = dest.stream.getAudioTracks()[0]!;

  const stream = new MediaStream([videoTrack, audioTrack]);

  const mimeType = pickSupportedMime(opts.preferredMimeType);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: opts.videoBitsPerSecond ?? 12_000_000,
    audioBitsPerSecond: opts.audioBitsPerSecond ?? 192_000,
  });

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };

  const stopped = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      try { opts.audioSourceNode.disconnect(dest); } catch { /* noop */ }
      videoTrack.stop();
      audioTrack.stop();
      resolve(new Blob(chunks, { type: mimeType.split(';')[0] }));
    };
  });

  recorder.start(/* timeslice */ 1000); // 1s chunks → safer for long takes

  return {
    stop: async () => { recorder.stop(); return stopped; },
    pause: () => recorder.pause(),
    resume: () => recorder.resume(),
    state: () => recorder.state,
  };
}

function pickSupportedMime(preferred?: string): string {
  const list = preferred ? [preferred, ...PREFERRED_MIMES] : PREFERRED_MIMES;
  for (const m of list) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  throw new Error('No supported MediaRecorder mimeType (need at minimum video/webm).');
}
```

**Key facts (verified):**

- `canvas.captureStream(fps)` produces a video track that emits a frame **at
  the requested fps OR whenever the canvas commits a draw** — whichever is
  slower. Verified by MDN — at 60fps you get up to 60.
- Combining canvas + `MediaStreamAudioDestinationNode` is the established
  Chromium pattern.
- `MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')` returns `true`
  in current Chromium / Electron 42. AV1 is hit-or-miss; do not require it.
  H.264-in-WebM is supported in Chromium for recording but not for `<video>`
  playback (use VP9 by default).
- `videoBitsPerSecond` is a hint, not a hard target. For "looks like YouTube"
  at 1080p60: 12-20 Mbps VP9. For 4K60: 30-50 Mbps. The user-facing UI exposes
  a `Quality: [SD | HD | 4K]` segmented control mapping to these.

### 3.3 Where to call `captureStream`

The Eviland canvas is the rendering surface of `createEvilandRenderer`. In the
main window, this is the `<canvas>` inside `Visualizer` / `FullscreenVisualizer`.
The existing `FullscreenVisualizer.tsx:598` already grabs
`canvas[data-newamp-visualizer-canvas]` — keep that selector contract.

For the **detached** case there are two strategies:

1. **Record in main renderer** (preferred default). Require `mirror = true`
   when recording → the main window draws the same frames as the detached
   window, and we capture the main canvas + audio. Loses one GPU pass for the
   recording duration; user accepts.
2. **Capture the detached window from main process.** Use
   `webContents.beginFrameSubscription` on the detached window to receive raw
   frame buffers, encode via `ffmpeg-static` — described in §3.4. Slower CPU
   path but works without mirroring.

Default to (1) and offer (2) as "Studio capture (high-quality)".

### 3.4 Offline deterministic export — `ffmpeg-static` + frame log

`ffmpeg-static` is already a runtime dep (verified, `package.json:171`). NewAmp
already wraps ffmpeg for transcode (`electron/transcode.ts`). Add a render
mode:

1. While the user plays a track, the main renderer **logs `EvilandFrame` +
   nowMs** to a ring buffer (uses `frameBus.subscribe`). Disk-back the buffer
   to a temp file for long takes (each frame ~250 bytes, so 1 hour at 60fps =
   ~54 MB — fine).
2. When the user clicks "Export deterministic 4K render", we:
   a. Open a headless `OffscreenCanvas` at the chosen resolution (3840×2160).
   b. Build a fresh `createEvilandRenderer` against it.
   c. Replay the frame log frame-by-frame at fixed dt; for each, render →
      `OffscreenCanvas.transferToImageBitmap()` → encode to PNG bytes via
      `convertToBlob({ type: 'image/png' })`.
   d. Stream PNGs into ffmpeg via stdin:

      ```
      ffmpeg -y -framerate 60 -f image2pipe -i - \
             -i audio-bounce.wav \
             -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p \
             -c:a aac -b:a 320k -shortest \
             out.mp4
      ```

      For audio, we either (i) use the original track file directly, or (ii)
      re-render via `OfflineAudioContext` with the same EQ/limiter chain so the
      exported video matches what the visualizer reacted to. (ii) is faithful.
3. ffmpeg invocation lives in main (renderer cannot spawn). Renderer sends a
   prepared `{frameLogPath, audioPath, outPath, width, height, fps, crf}`
   payload to a new `ipcMain.handle('eviland:export-video', ...)` which spawns
   the bundled ffmpeg binary (`ffmpeg-static`) and streams progress back.

This is the path that gets *production*-quality (deterministic, no dropped
frames, full bitrate) renders for YouTube / Instagram / portfolio use. The live
`MediaRecorder` path is for "share this clip now" capture.

### 3.5 File save

Reuse the existing `media:save-capture` IPC handler
(`electron/main.ts` already routes `saveCaptureBytes` from preload). The
recorder's `Blob` is serialised the same way as the current PNG/WebM flow:

```ts
const dataUrl = await blobToDataUrl(blob);
const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
await api.saveCaptureBytes({
  base64,
  defaultName: `eviland-${trackSlug}-${Date.now()}`,
  filterName: 'WebM video',
  ext: 'webm',
});
```

For large takes (>~50 MB), switch to a chunked write path — add a
`media:start-capture-write`, `media:append-capture-chunk`, `media:finalize-capture`
IPC trio so we don't materialize huge base64 strings in renderer memory. Hook
`recorder.ondataavailable` to stream each chunk directly to the IPC sink.

### 3.6 UI

In `FullscreenVisualizer.tsx`'s control bar, replace the existing
`toggleRecord` with:

```
[ ● Record ] [ Quality: SD HD 4K ]   ⏱ 00:42   ⏺ 12 Mbps · vp9
```

- `●` red while recording, animated.
- Quality preset maps to `(fps, videoBitsPerSecond, resolution)`:
  - SD: 30fps, 4 Mbps, current canvas size
  - HD: 60fps, 12 Mbps, current canvas size (clamped to 1080p)
  - 4K: 60fps, 30 Mbps, route through Offline export (3.4)
- Live timer + recorded bytes counter.

### 3.7 Smoke

`scripts/live-recorder-smoke.mjs` (extend existing `scripts/viz-capture-smoke.mjs`):
1. Launch with `NEWAMP_RECORD_SMOKE=1`.
2. Renderer probe: start recording for 3s on the eviland canvas with a fake
   60Hz `OscillatorNode` audio source, stop, assert resulting WebM `Blob.size >
   200_000`, mime `video/webm`.
3. Open the WebM with `node` + `ffmpeg -i out.webm 2>&1`, parse stderr,
   assert `Stream #0:0: Video: vp9` AND `Stream #0:1: Audio: opus`.
4. Offline path: assert `eviland:export-video` IPC produces a valid mp4 with
   the same audio length as the source.

---

## 4. Cross-cutting

### 4.1 Files touched

| Path | Change |
|---|---|
| `electron/main.ts` | + permission handlers, + detached-viz IPC, + display events, + capture-stream IPCs |
| `electron/preload.ts` | + `detachedViz` API, + `eviland:frame-port` bridge, + chunked-capture IPCs |
| `src/audio/engine.ts` | + `attachLiveInput`/`stopLiveInput`/`isLiveInputActive`/`setLiveMonitoring` |
| `src/audio/live-input.ts` *(new)* | device enumeration + `openLiveInputStream` |
| `src/visualizer/frame-bus.ts` *(new)* | reactor → consumer fan-out + IPC port + backpressure |
| `src/components/Visualizer.tsx` | eviland branch publishes through `frameBus` instead of direct render |
| `src/components/FullscreenVisualizer.tsx` | replace `toggleRecord` with `startLiveRecording` + add detached/live-input controls |
| `src/components/views/SettingsView.tsx` | + audio-input device picker block |
| `src/recording/live-recorder.ts` *(new)* | the helper from §3.2 |
| `src/recording/offline-export.ts` *(new)* | frame-log + ffmpeg orchestration (renderer side) |
| `src/detached/main.tsx` *(new)* | detached renderer entry |
| `detached.html` *(new)* | detached entry HTML |
| `vite.config.ts` | add `detached` rollup input |
| `scripts/live-input-smoke.mjs` *(new)* | §1.8 |
| `scripts/detached-viz-smoke.mjs` *(new)* | §2.11 |
| `scripts/live-recorder-smoke.mjs` *(new)* | §3.7 |
| `package.json` | + 3 smoke scripts wired to `smoke:live-input`, `smoke:detached`, `smoke:record` |

### 4.2 Order of implementation

1. **Permissions handler** (5 lines, unblocks all of §1).
2. **Live input → engine.attachLiveInput** + UI source picker. Ship + smoke.
3. **`frameBus` refactor** of the eviland branch in `Visualizer.tsx`. No behavior
   change — pure plumbing. Re-run `scripts/eviland-capture.mjs` and
   `scripts/eviland-smoke.mjs` to prove zero regression.
4. **Detached window + port pair** end-to-end. Ship + smoke.
5. **Live recorder v1** (replace existing minimal recorder; canvas + audio +
   VP9 + bitrate config). Ship + smoke.
6. **Offline ffmpeg export** as a follow-up — bigger surface, needs its own
   spec doc.

### 4.3 Non-negotiables (cross-ref `00-VISION.md`)

- `scripts/eviland-capture.mjs` PNG must still pass after every step.
- `scripts/eviland-smoke.mjs` reactivity must still pass.
- `npm run typecheck` clean.
- Live input MUST NOT feed `masterGain → limiter → destination` by default
  (feedback). Monitoring is opt-in with a warning.
- The detached window MUST be a thin renderer. No reactor, no audio context.
- One frame producer. One reactor instance. The producer's existence is not
  duplicated when the detached window mirrors.

---

## 5. Verified sources

- Electron `session` permission handlers — `electronjs.org/docs/latest/api/session` — `'media'` is the single permission string; uses `mediaType`/`mediaTypes` on the details object; no separate `audioCapture`. (Fetched 2026-05-30.)
- Electron `MessageChannelMain` — `electronjs.org/docs/latest/api/message-channel-main` — `new MessageChannelMain()`, `webContents.postMessage(channel, msg, [port])`, ports surface on the renderer in `event.ports`. (Fetched 2026-05-30.)
- Electron `screen` — `electronjs.org/docs/latest/api/screen` — `getAllDisplays()`, `display-added`/`display-removed`, `getDisplayMatching(bounds)`, `display.bounds`/`workArea`/`scaleFactor`. (Fetched 2026-05-30.)
- MDN `MediaDevices.getUserMedia` — `developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia` — confirms current constraint shape. (Fetched 2026-05-30.)
- MDN `AudioContext.createMediaStreamSource` — `developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaStreamSource` — Baseline since 2021, auto-resamples to context rate. (Fetched 2026-05-30.)
- MDN `MediaRecorder` — `developer.mozilla.org/en-US/docs/Web/API/MediaRecorder` — `isTypeSupported`, `videoBitsPerSecond`, combining canvas + MSADest into one MediaStream. (Fetched 2026-05-30.)

### 5.1 Uncertainty / drift risk

- **`googXxx` constraints**: MDN did not directly confirm 2026 Chromium behavior. They are ignored by current Chrome but harmless. We do not send them.
- **Detached window throttling on un-focused projector**: setting `backgroundThrottling: false` should work but Chromium has changed throttling heuristics across versions; verify with a real second display before shipping. The visible compositor change in Electron 30+ (`disable-features=VizDisplayCompositor`) is *not* required for this case.
- **MediaRecorder + `captureStream` framerate on weak GPUs**: at 60fps the recorder will drop frames if the renderer is GPU-bound. Mitigation: clamp recording fps to 30 in `Lite` perf tier (already plumbed via `perfTier`).
- **MessagePort throughput in Chromium**: not directly benchmarked in Electron docs. At 60 Hz × ~300 B/payload (~18 KB/s) we are nowhere near the structured-clone bottleneck (~hundreds of MB/s on modern hardware). The backpressure design is defensive, not load-bearing.
- **Offline `OffscreenCanvas` + WebGL2 RGBA16F**: requires verifying that the renderer's float texture support exists in worker context. If not, fall back to running export on the main thread with a hidden full-resolution canvas.
