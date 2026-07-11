// Craft regression matrix: shell x skin screenshot grid.
//
//   npm run craft:matrix               capture -> craft-matrix/current/,
//                                      diff against craft-matrix/baseline/ if present
//   npm run craft:matrix -- --baseline promote craft-matrix/current/ -> baseline/
//
// Captures the four core views (Home, Library, Now Playing, Settings) across
// all four shells x a six-skin subset (96 shots), plus one shot per compact
// deck skin (8 shots) = 104 PNGs. Reuses the screenshot-gallery fixture
// seeding and the shot harness in electron/main.ts: the whole capture plan is
// generated here as { file, action } steps and handed to the app via
// NEWAMP_SCREENSHOT_PLAN (see runScreenshotGallery). Shell and skin switching
// go through the real Settings UI (ShellPicker buttons + skin swatches) so the
// shots exercise the same code paths a user does.
//
// The pixel diff is dependency-free: a minimal PNG decoder (node:zlib inflate
// + scanline unfilter, 8-bit RGB/RGBA non-interlaced — exactly what
// capturePage emits) feeds a per-pixel compare. Results land in
// craft-matrix/report.json and craft-matrix/report.txt.

import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  GALLERY_ALBUMS,
  assertFfmpegAvailable,
  createAlbumFixture,
  runElectronScreenshots,
  writeSmokeSettings,
} from './screenshot-gallery.mjs';

const matrixRoot = resolve('craft-matrix');
const currentDir = join(matrixRoot, 'current');
const baselineDir = join(matrixRoot, 'baseline');
const reportJsonPath = join(matrixRoot, 'report.json');
const reportTextPath = join(matrixRoot, 'report.txt');
const smokeRoot = resolve('tmp', 'craft-matrix');
const userData = join(smokeRoot, 'user-data');
const mediaDir = join(smokeRoot, 'media');
const planPath = join(smokeRoot, 'plan.json');

// Labels must match the UI copy: ShellPicker SHELLS[].label and the
// SettingsView THEMES/EXTRA_THEMES[].label the swatch buttons render.
const SHELLS = [
  { id: 'retro', label: 'Retro' },
  { id: 'modern', label: 'Modern' },
  { id: 'liquid-glass', label: 'Liquid Glass' },
  { id: 'concourse', label: 'Concourse' },
];
const SKINS = [
  { id: 'classic', label: 'Classic' },
  { id: 'steel', label: 'Steel' },
  { id: 'ice', label: 'Ice' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'miami', label: 'Miami' },
  { id: 'mono', label: 'Mono' },
];
// Settings first: the shell/skin switch happens there, so it is already the
// active view when the cell's first frame is captured.
const VIEWS = [
  { id: 'settings', nav: 'Settings' },
  { id: 'home', nav: 'Home' },
  { id: 'library', nav: 'Library' },
  { id: 'now-playing', nav: 'Now Playing' },
];
// One shot per deck skin, all in the same retro/classic base so only the
// deck itself varies. Sizes mirror src/components/decks/types.ts DECK_SKINS:
// each skin reshapes the window, and the capture must wait for that resize to
// land or a slow IPC round-trip leaves the shot at the previous deck's size.
const DECK_SKINS = [
  { id: 'bento', width: 820, height: 112 },
  { id: 'winamp-classic', width: 550, height: 232 },
  { id: 'winamp-industrial', width: 550, height: 232 },
  { id: 'record-player', width: 540, height: 540 },
  { id: 'jukebox', width: 420, height: 560 },
  { id: 'cassette', width: 720, height: 530 },
  { id: 'discman', width: 620, height: 460 },
  { id: 'retro-tv', width: 520, height: 430 },
];

// Per-channel tolerance for "pixel changed": absorbs 1-bit rounding jitter
// from GPU/AA differences without hiding real skin regressions.
const CHANNEL_TOLERANCE = 2;
const MATRIX_MIN_BYTES = 20_000;
const DECK_MIN_BYTES = 3_000;
const RUN_TIMEOUT_MS = 540_000;

if (process.argv.includes('--baseline')) {
  await promoteBaseline();
} else {
  await captureMatrix();
  if (existsSync(baselineDir)) {
    await diffAgainstBaseline();
  } else {
    console.log(
      `\nNo baseline at ${baselineDir} — run "npm run craft:matrix -- --baseline" to promote this capture.`,
    );
  }
}

async function promoteBaseline() {
  const shots = existsSync(currentDir)
    ? (await readdir(currentDir)).filter((f) => f.endsWith('.png'))
    : [];
  if (!shots.length) {
    console.error('craft-matrix/current is empty — run "npm run craft:matrix" first.');
    process.exit(1);
  }
  await rm(baselineDir, { recursive: true, force: true });
  await cp(currentDir, baselineDir, { recursive: true });
  console.log(`Promoted ${shots.length} shots: craft-matrix/current -> craft-matrix/baseline`);
}

async function captureMatrix() {
  assertFfmpegAvailable();

  await rm(smokeRoot, { recursive: true, force: true });
  await rm(currentDir, { recursive: true, force: true });
  await mkdir(mediaDir, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(currentDir, { recursive: true });

  for (const album of GALLERY_ALBUMS) await createAlbumFixture(mediaDir, album);
  await writeSmokeSettings(userData, mediaDir);

  const plan = buildPlan();
  await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');
  console.log(`Capturing ${plan.length} shots -> ${currentDir}`);

  const started = Date.now();
  const result = await runElectronScreenshots({
    env: {
      NEWAMP_SCREENSHOT_GALLERY: '1',
      NEWAMP_SCREENSHOT_DIR: currentDir,
      NEWAMP_SCREENSHOT_PLAN: planPath,
      NEWAMP_SMOKE_USER_DATA: userData,
    },
    timeoutMs: RUN_TIMEOUT_MS,
    onOutput: (line) => {
      if (line.startsWith('[newamp-screenshot-plan]')) console.log(line);
    },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  assert.equal(result.ok, true, 'screenshot run should report ok');
  for (const step of plan) {
    const fullPath = join(currentDir, step.file);
    const minBytes = step.file.startsWith('deck--') ? DECK_MIN_BYTES : MATRIX_MIN_BYTES;
    assert.ok(existsSync(fullPath), `${step.file} should exist`);
    assert.ok(
      statSync(fullPath).size > minBytes,
      `${step.file} should be a non-trivial PNG (> ${minBytes} bytes)`,
    );
  }
  console.log(`Captured ${plan.length}/${plan.length} shots in ${seconds}s`);
}

function buildPlan() {
  const plan = [];
  let first = true;
  for (const shell of SHELLS) {
    for (const skin of SKINS) {
      for (const view of VIEWS) {
        const file = `${shell.id}--${skin.id}--${view.id}.png`;
        const surface = `${shell.id}--${skin.id}--${view.id}`;
        if (view.id === 'settings') {
          plan.push({
            file,
            action: [
              first ? bootstrapJs() : '',
              setShellAndSkinJs(shell.label, skin.label),
              `return shot.summary(${JSON.stringify(surface)});`,
            ].join('\n'),
          });
          first = false;
        } else {
          plan.push({
            file,
            action: [
              `await shot.go(${JSON.stringify(view.nav)});`,
              'await shot.sleep(300);',
              `return shot.summary(${JSON.stringify(surface)});`,
            ].join('\n'),
          });
        }
      }
    }
  }
  for (const [index, deck] of DECK_SKINS.entries()) {
    plan.push({
      file: `deck--${deck.id}.png`,
      action: [
        // Reset to the base look before the first deck shot so the deck row
        // is captured in a single, stable shell/skin.
        index === 0 ? setShellAndSkinJs('Retro', 'Classic') : '',
        `await shot.openDeck(${JSON.stringify(deck.id)});`,
        `await shot.waitFor('deck window ${deck.width}x${deck.height}', () =>
          Math.abs(window.innerWidth - ${deck.width}) <= 2 && Math.abs(window.innerHeight - ${deck.height}) <= 2, 15000);`,
        'await shot.sleep(300);',
        `return shot.summary(${JSON.stringify(`deck--${deck.id}`)});`,
      ].join('\n'),
    });
  }
  return plan;
}

// One-time setup: freeze CSS animation so pixels are stable between runs, and
// park a paused track at t=5s so Now Playing / transport chrome is populated
// but deterministic (no advancing clock, no reactive-audio motion).
function bootstrapJs() {
  return `
    const freeze = document.createElement('style');
    freeze.id = 'newamp-craft-freeze';
    freeze.textContent = '*, *::before, *::after { animation-play-state: paused !important; transition: none !important; caret-color: transparent !important; }';
    document.head.appendChild(freeze);
    await shot.playTrack(${JSON.stringify(GALLERY_ALBUMS[3].title)});
    const pauseBtn = await shot.waitFor('transport pause button', () =>
      document.querySelector('[data-newamp-transport] button[title^="Pause"]'));
    pauseBtn.click();
    await shot.sleep(250);
    window.__newampSmoke?.seek?.(5);
    await shot.sleep(1200);
  `;
}

// Drive the real Settings UI: ShellPicker radio buttons and the skin swatch
// grid (button whose leaf <div> text equals the skin label). Clicking the
// swatch goes through usePlayerStore.setTheme -> applyTheme, exactly like a
// user changing skins.
function setShellAndSkinJs(shellLabel, skinLabel) {
  return `
    await shot.go('Settings');
    const shellBtn = await shot.waitFor('shell button ' + ${JSON.stringify(shellLabel)}, () =>
      Array.from(document.querySelectorAll('.shell-picker-btn'))
        .find((b) => (b.textContent || '').trim() === ${JSON.stringify(shellLabel)}));
    shellBtn.click();
    const skinSection = await shot.waitFor('skin section', () =>
      Array.from(document.querySelectorAll('section'))
        .find((s) => ((s.querySelector('h2') || {}).textContent || '').trim().toLowerCase() === 'skin'));
    const skinBtn = await shot.waitFor('skin button ' + ${JSON.stringify(skinLabel)}, () =>
      Array.from(skinSection.querySelectorAll('button'))
        .find((b) => Array.from(b.querySelectorAll('div'))
          .some((d) => d.children.length === 0 && (d.textContent || '').trim() === ${JSON.stringify(skinLabel)})));
    skinBtn.click();
    await shot.sleep(400);
  `;
}

// ---------------------------------------------------------------------------
// Baseline diff
// ---------------------------------------------------------------------------

async function diffAgainstBaseline() {
  const baselineFiles = (await readdir(baselineDir)).filter((f) => f.endsWith('.png')).sort();
  const currentFiles = (await readdir(currentDir)).filter((f) => f.endsWith('.png')).sort();
  const all = [...new Set([...baselineFiles, ...currentFiles])].sort();

  const entries = [];
  for (const file of all) {
    const inBaseline = baselineFiles.includes(file);
    const inCurrent = currentFiles.includes(file);
    if (!inBaseline) {
      entries.push({ file, status: 'added', pctPixelsChanged: null });
      continue;
    }
    if (!inCurrent) {
      entries.push({ file, status: 'removed', pctPixelsChanged: null });
      continue;
    }
    const baselineBuf = await readFile(join(baselineDir, file));
    const currentBuf = await readFile(join(currentDir, file));
    entries.push({ file, ...comparePngs(baselineBuf, currentBuf) });
  }

  const totals = {
    compared: entries.filter((e) => e.status !== 'added' && e.status !== 'removed').length,
    identical: entries.filter((e) => e.status === 'identical').length,
    changed: entries.filter((e) => e.status === 'changed' || e.status === 'dimensions-changed').length,
    added: entries.filter((e) => e.status === 'added').length,
    removed: entries.filter((e) => e.status === 'removed').length,
  };
  const worstOffenders = entries
    .filter((e) => typeof e.pctPixelsChanged === 'number' && e.pctPixelsChanged > 0)
    .sort((a, b) => b.pctPixelsChanged - a.pctPixelsChanged)
    .slice(0, 10)
    .map((e) => ({ file: e.file, status: e.status, pctPixelsChanged: e.pctPixelsChanged }));

  const report = {
    generatedAt: new Date().toISOString(),
    baselineDir,
    currentDir,
    channelTolerance: CHANNEL_TOLERANCE,
    totals,
    worstOffenders,
    entries,
  };
  await writeFile(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');

  const lines = [];
  lines.push(`NewAmp craft matrix report — ${report.generatedAt}`);
  lines.push(`baseline: ${baselineDir} (${baselineFiles.length} shots)`);
  lines.push(`current:  ${currentDir} (${currentFiles.length} shots)`);
  lines.push('');
  lines.push(
    `identical: ${totals.identical}   changed: ${totals.changed}   added: ${totals.added}   removed: ${totals.removed}`,
  );
  if (worstOffenders.length) {
    lines.push('');
    lines.push('worst offenders (% pixels changed):');
    for (const e of worstOffenders) {
      lines.push(`  ${String(e.pctPixelsChanged.toFixed(2)).padStart(6)}%  ${e.file}${e.status === 'dimensions-changed' ? '  (dimensions changed)' : ''}`);
    }
  }
  for (const status of ['added', 'removed']) {
    const list = entries.filter((e) => e.status === status);
    if (list.length) {
      lines.push('');
      lines.push(`${status}:`);
      for (const e of list) lines.push(`  ${e.file}`);
    }
  }
  const text = lines.join('\n');
  await writeFile(reportTextPath, `${text}\n`, 'utf8');
  console.log(`\n${text}`);
  console.log(`\nReport: ${reportJsonPath}`);
}

function comparePngs(baselineBuf, currentBuf) {
  if (baselineBuf.equals(currentBuf)) {
    return { status: 'identical', pctPixelsChanged: 0 };
  }
  let a;
  let b;
  try {
    a = decodePng(baselineBuf);
    b = decodePng(currentBuf);
  } catch (err) {
    return { status: 'decode-error', pctPixelsChanged: null, note: String(err instanceof Error ? err.message : err) };
  }
  if (a.width !== b.width || a.height !== b.height) {
    return {
      status: 'dimensions-changed',
      pctPixelsChanged: 100,
      note: `${a.width}x${a.height} -> ${b.width}x${b.height}`,
    };
  }
  const totalPixels = a.width * a.height;
  let changed = 0;
  for (let i = 0; i < totalPixels; i += 1) {
    const [ar, ag, ab, aa] = readPixel(a, i);
    const [br, bg, bb, ba] = readPixel(b, i);
    if (
      Math.abs(ar - br) > CHANNEL_TOLERANCE ||
      Math.abs(ag - bg) > CHANNEL_TOLERANCE ||
      Math.abs(ab - bb) > CHANNEL_TOLERANCE ||
      Math.abs(aa - ba) > CHANNEL_TOLERANCE
    ) {
      changed += 1;
    }
  }
  const pct = (changed / totalPixels) * 100;
  return {
    status: changed > 0 ? 'changed' : 'identical',
    pctPixelsChanged: Number(pct.toFixed(4)),
    changedPixels: changed,
    totalPixels,
  };
}

function readPixel(img, index) {
  const o = index * img.channels;
  return [
    img.pixels[o],
    img.pixels[o + 1],
    img.pixels[o + 2],
    img.channels === 4 ? img.pixels[o + 3] : 255,
  ];
}

// Minimal PNG decoder for the harness's own output: 8-bit, RGB or RGBA,
// non-interlaced (capturePage always emits 8-bit RGBA). Anything else throws
// and the entry is reported as decode-error instead of silently passing.
function decodePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error('not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new Error(`truncated PNG data (${raw.length} < ${(stride + 1) * height})`);
  }
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const lineStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[lineStart + x];
      const left = x >= channels ? pixels[outStart + x - channels] : 0;
      const up = y > 0 ? pixels[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[prevStart + x - channels] : 0;
      let value;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + left;
          break;
        case 2:
          value = rawByte + up;
          break;
        case 3:
          value = rawByte + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = rawByte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      pixels[outStart + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}
