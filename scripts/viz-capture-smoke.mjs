import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Static wiring smoke for the visualizer capture / share loop. Pure-node and
// CI-safe: confirms the capture IPC is wired end to end (main handler →
// preload bridge → renderer api → NewAmpAPI type + graceful fallback) and that
// the FullscreenVisualizer exposes the capture/record controls.

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const [main, preload, api, types, fullscreen] = await Promise.all([
  read('electron/main.ts'),
  read('electron/preload.ts'),
  read('src/lib/api.ts'),
  read('shared/types.ts'),
  read('src/components/FullscreenVisualizer.tsx'),
]);

// Main-process IPC handlers.
assert.match(main, /ipcMain\.handle\(\s*'media:capture-page'/, 'main must handle media:capture-page');
assert.match(main, /ipcMain\.handle\(\s*'media:copy-png'/, 'main must handle media:copy-png');
assert.match(main, /ipcMain\.handle\(\s*'media:save-capture'/, 'main must handle media:save-capture');
assert.match(main, /capturePage\(/, 'capture must use webContents.capturePage (works for every viz mode incl. the Butterchurn iframe)');
assert.match(main, /clipboard\.writeImage\(/, 'copy-png must write to the Electron clipboard');

// Preload bridge.
assert.match(preload, /captureVisualizerPng:/, 'preload must expose captureVisualizerPng');
assert.match(preload, /copyPngToClipboard:/, 'preload must expose copyPngToClipboard');
assert.match(preload, /saveCaptureBytes:/, 'preload must expose saveCaptureBytes');
assert.match(preload, /'media:capture-page'/, 'preload must invoke media:capture-page');

// Renderer api + type + graceful fallback.
assert.match(types, /captureVisualizerPng:\s*\(/, 'NewAmpAPI must type captureVisualizerPng');
assert.match(types, /saveCaptureBytes:\s*\(/, 'NewAmpAPI must type saveCaptureBytes');
assert.match(api, /captureVisualizerPng: async \(\) => null/, 'api fallback must stub captureVisualizerPng');
assert.match(api, /saveCaptureBytes: async \(\) => null/, 'api fallback must stub saveCaptureBytes');

// FullscreenVisualizer controls.
assert.match(fullscreen, /data-newamp-viz-capture-button/, 'fullscreen visualizer must expose a Capture button');
assert.match(fullscreen, /data-newamp-viz-record-button/, 'fullscreen visualizer must expose a Record button');
assert.match(fullscreen, /captureStream\(/, 'record must stream the visualizer canvas via captureStream');
assert.match(fullscreen, /new MediaRecorder\(/, 'record must use MediaRecorder');

console.log(JSON.stringify({ ok: true }, null, 2));
