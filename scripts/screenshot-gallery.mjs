// Screenshot gallery driver. Boots the built app against a tiny generated
// fixture library and captures the README/marketing gallery shots via the
// shot harness in electron/main.ts (NEWAMP_SCREENSHOT_GALLERY=1).
//
// The fixture-seeding and Electron-driving pieces are exported so other
// screenshot harnesses (scripts/craft-matrix.mjs) can reuse them; running
// this file directly still produces the classic gallery.

import assert from 'node:assert/strict';
import electronPath from 'electron';
import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve('.');

export const GALLERY_ALBUMS = [
  {
    artist: 'Deerhoof',
    album: "Apple O'",
    title: 'Dummy Discards A Heart',
    year: 2003,
    genre: 'Indie Rock',
    frequency: 523,
    palette: ['#f54666', '#f4d25d', '#171717', '#7be0ad'],
  },
  {
    artist: 'Wilco',
    album: 'Yankee Hotel Foxtrot',
    title: 'I Am Trying to Break Your Heart',
    year: 2002,
    genre: 'Alternative',
    frequency: 392,
    palette: ['#1e2d4f', '#c6d8e7', '#d34d3f', '#f1e6c7'],
  },
  {
    artist: 'Hella',
    album: 'Hold Your Horse Is',
    title: 'Biblical Violence',
    year: 2002,
    genre: 'Math Rock',
    frequency: 880,
    palette: ['#101114', '#e8f1ff', '#19f29b', '#4456ff'],
  },
  {
    artist: 'The Dave Brubeck Quartet',
    album: 'Time Out',
    title: 'Take Five',
    year: 1959,
    genre: 'Jazz',
    frequency: 659,
    palette: ['#f3efe1', '#22324c', '#d14a35', '#111111'],
  },
];

// Manually contributed screenshots (pre-2.0 design) were retired 2026-07-17 —
// real-library-shots.mjs and deck-shots.mjs now produce the marketing set.

export function assertFfmpegAvailable() {
  if (!ffmpeg) {
    console.error('ffmpeg-static did not resolve a binary for this platform');
    process.exit(1);
  }
}

export async function createAlbumFixture(mediaDir, album) {
  const albumDir = join(mediaDir, safeName(`${album.artist} - ${album.album}`));
  await mkdir(albumDir, { recursive: true });
  const ppmPath = join(albumDir, 'cover.ppm');
  const coverPath = join(albumDir, 'cover.jpg');
  await writePpmCover(ppmPath, album.palette);
  run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', ppmPath, '-frames:v', '1', coverPath]);

  const trackPath = join(albumDir, `${safeName(album.title)}.mp3`);
  run(ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${album.frequency}:duration=18`,
    '-metadata',
    `title=${album.title}`,
    '-metadata',
    `artist=${album.artist}`,
    '-metadata',
    `album=${album.album}`,
    '-metadata',
    `album_artist=${album.artist}`,
    '-metadata',
    `date=${album.year}`,
    '-metadata',
    `genre=${album.genre}`,
    '-c:a',
    'libmp3lame',
    '-q:a',
    '5',
    trackPath,
  ]);
}

export async function writeSmokeSettings(userDataDir, mediaDir, overrides = {}) {
  await writeFile(
    join(userDataDir, 'settings.json'),
    JSON.stringify(
      {
        libraryRoots: [mediaDir],
        libraryAutoWatch: false,
        theme: 'classic',
        customSkin: null,
        lastfmEnabled: false,
        lastfmApiKey: null,
        lastfmSharedSecret: null,
        lastfmSessionKey: null,
        lastfmUsername: null,
        lastfmAuthToken: null,
        openaiApiKey: null,
        openaiModel: 'gpt-5.4-mini',
        firstLaunchTutorialSeen: true,
        textScale: 1,
        crossfadeMs: 0,
        replayGain: 'off',
        limiterEnabled: true,
        preampDb: 0,
        resumeState: null,
        compactMode: false,
        alwaysOnTop: false,
        visualizerPreset: 'neon-waves',
        volume: 0.55,
        playbackRate: 1,
        audioOutputDeviceId: null,
        autoDjEnabled: false,
        autoDjTarget: 24,
        autoDjSmartRuleId: null,
        equalizer: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        eqEnabled: false,
        ...overrides,
      },
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * Launch the built app with screenshot-harness env vars and wait for the
 * `[newamp-screenshot-gallery] {...}` result marker on stdout.
 *
 * options.env      — extra env vars merged over process.env
 * options.timeoutMs — overall deadline (default 70s; matrix runs need more)
 * options.onOutput — optional callback for non-marker stdout lines (progress)
 */
export function runElectronScreenshots({ env = {}, timeoutMs = 70000, onOutput } = {}) {
  const marker = '[newamp-screenshot-gallery] ';
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(String(electronPath), ['.'], {
      cwd: appRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        ...env,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let pendingStdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      finish(new Error(`Screenshot run timed out without result marker. stderr:\n${tail(stderr)}`));
    }, timeoutMs);

    const handleLine = (line) => {
      if (!line) return;
      if (line.startsWith(marker)) {
        try {
          finish(null, JSON.parse(line.slice(marker.length)));
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      onOutput?.(line);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pendingStdout += chunk;
      const lines = pendingStdout.split(/\r?\n/);
      pendingStdout = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => finish(err));
    child.on('exit', (code) => {
      handleLine(pendingStdout);
      pendingStdout = '';
      if (!settled) {
        finish(
          new Error(
            `Electron exited ${code ?? 'without code'} before screenshots completed.\nstderr:\n${tail(stderr)}`,
          ),
        );
      }
    });

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!child.killed) child.kill();
      if (err) rejectPromise(err);
      else resolvePromise(value);
    }
  });
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status})\n${result.stderr || result.stdout}`);
  }
}

async function writePpmCover(path, palette) {
  const width = 720;
  const height = 720;
  const pixels = Buffer.alloc(width * height * 3);
  const colors = palette.map(hexToRgb);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2;
      const base = mix(colors[0], colors[1], t);
      const band = Math.abs(((x * 0.9 + y * 1.35) % 180) - 90) < 14 ? colors[2] : base;
      const ring = Math.abs(Math.hypot(x - width * 0.5, y - height * 0.5) - 230) < 11 ? colors[3] : band;
      const block = x > width * 0.12 && x < width * 0.88 && y > height * 0.62 && y < height * 0.72 ? mix(ring, colors[2], 0.45) : ring;
      const index = (y * width + x) * 3;
      pixels[index] = block[0];
      pixels[index + 1] = block[1];
      pixels[index + 2] = block[2];
    }
  }
  await writeFile(path, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
}

function safeName(value) {
  return value.replace(/[<>:"/\\|?*]+/g, '-').replace(/\s+/g, ' ').trim();
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function tail(text) {
  return text.split(/\r?\n/).slice(-80).join('\n');
}

async function main() {
  const screenshotRoot = resolve('assets', 'screenshots');
  const smokeRoot = resolve('tmp', 'screenshot-gallery');
  const userData = join(smokeRoot, 'user-data');
  const mediaDir = join(smokeRoot, 'media');

  assertFfmpegAvailable();

  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(mediaDir, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(screenshotRoot, { recursive: true });

  for (const album of GALLERY_ALBUMS) await createAlbumFixture(mediaDir, album);
  await writeSmokeSettings(userData, mediaDir);

  const result = await runElectronScreenshots({
    env: {
      NEWAMP_SCREENSHOT_GALLERY: '1',
      NEWAMP_SCREENSHOT_DIR: screenshotRoot,
      NEWAMP_SMOKE_USER_DATA: userData,
    },
  });

  for (const file of result.files) {
    const fullPath = resolve(file);
    assert.ok(existsSync(fullPath), `${file} should exist`);
    assert.ok(statSync(fullPath).size > 20_000, `${file} should be a non-trivial PNG`);
  }

  console.log(JSON.stringify(result, null, 2));
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  await main();
}
