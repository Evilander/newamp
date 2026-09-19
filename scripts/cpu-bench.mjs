// CPU use of the real app, per process type, with a large library open.
// Builds a synthetic library (27,000 tracks, 4,500 artists by default, plus a
// few real audio files to play), launches the built app against it, drives it
// over the DevTools protocol and samples each Electron process's CPU time.
//
//   npm run bench:cpu                       # needs a prior `npm run build`
//   npm run bench:cpu -- --disable-gpu      # software compositing, as on
//                                           # Linux machines whose GPU
//                                           # Chromium blocklists
//   npm run bench:cpu -- --tracks 100000 --artists 12000 --secs 20
//
// Figures are % of ONE core (100 = one core busy). Windows, macOS and Linux.
import electronPath from 'electron';
import ffmpeg from 'ffmpeg-static';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const TRACKS = Number(opt('--tracks', 27000));
const ARTISTS = Number(opt('--artists', 4500));
const SECS = Number(opt('--secs', 12));
const STATES = opt('--states', 'idle-library,playing-library,playing-home,playing-artists,playing-nowplaying').split(',');
const disableGpu = argv.includes('--disable-gpu');
const exe = String(electronPath);
const root = resolve('tmp', 'cpu-bench', `${TRACKS}-${ARTISTS}`);
const userData = join(root, 'user-data');
const media = join(root, 'media');

if (!existsSync(resolve('dist', 'index.html')) || !existsSync(resolve('dist-electron', 'electron', 'library.js'))) {
  console.error('Build first: npm run build');
  process.exit(2);
}
if (!existsSync(join(userData, 'library.db'))) await buildLibrary();

// --- per-process CPU seconds ---------------------------------------------------
function cpuSnapshot() {
  if (process.platform === 'win32') {
    const ps = `$ErrorActionPreference='SilentlyContinue';
$procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' };
$out = foreach ($p in $procs) { $g = Get-Process -Id $p.ProcessId; $t = 'main'; if ($p.CommandLine -match '--type=([a-z-]+)') { $t = $Matches[1] }; [pscustomobject]@{ id = $p.ProcessId; type = $t; cpu = $g.CPU } };
$out | ConvertTo-Json -Compress`;
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows : [rows];
  }
  if (process.platform === 'linux') {
    const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;
    const rows = [];
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try {
        if (readlinkSync(`/proc/${pid}/exe`) !== exe) continue;
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        rows.push({ id: Number(pid), type: /--type=([a-z-]+)/.exec(cmd)?.[1] ?? 'main', cpu: (Number(fields[11]) + Number(fields[12])) / ticks });
      } catch {
        /* process went away or isn't ours */
      }
    }
    return rows;
  }
  const raw = execFileSync('ps', ['-A', '-o', 'pid=,time=,command='], { encoding: 'utf8' });
  return raw.split('\n').filter((line) => line.includes(exe)).map((line) => {
    const [pid, time, ...cmd] = line.trim().split(/\s+/);
    const parts = time.split(':').map(Number);
    const seconds = parts.reduce((sum, value) => sum * 60 + value, 0);
    return { id: Number(pid), type: /--type=([a-z-]+)/.exec(cmd.join(' '))?.[1] ?? 'main', cpu: seconds };
  });
}

async function measure(state) {
  const a = cpuSnapshot();
  const t0 = performance.now();
  await sleep(SECS * 1000);
  const b = cpuSnapshot();
  const dt = (performance.now() - t0) / 1000;
  const byType = {};
  let total = 0;
  for (const p of b) {
    const pct = (((p.cpu ?? 0) - (a.find((x) => x.id === p.id)?.cpu ?? 0)) / dt) * 100;
    byType[p.type] = (byType[p.type] ?? 0) + pct;
    total += pct;
  }
  return { state, total: round(total), renderer: round(byType.renderer ?? 0), gpu: round(byType['gpu-process'] ?? 0), main: round(byType.main ?? 0) };
}

// --- drive the app ---------------------------------------------------------------
const port = 9600 + Math.floor(Math.random() * 300);
const child = spawn(exe, ['.', `--remote-debugging-port=${port}`, ...(disableGpu ? ['--disable-gpu'] : [])], {
  cwd: resolve('.'),
  env: { ...process.env, NODE_ENV: 'production', NEWAMP_USER_DATA_DIR: userData, NEWAMP_SESSION_DATA_DIR: join(root, 'session') },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
const watchdog = setTimeout(() => stop(new Error('timed out')), (STATES.length * (SECS + 8) + 90) * 1000);

let ws;
let seq = 0;
const pending = new Map();
try {
  ws = await connect();
  const results = [];
  await evaluate(`await waitFor('app', () => document.querySelector('[data-newamp-transport]'), 30000);
    await sleep(8000);
    const start = [...document.querySelectorAll('button')].find((b) => /START LISTENING/i.test(b.textContent || ''));
    if (start) start.click();`);
  for (const state of STATES) {
    if (state === 'idle-library') await evaluate(`await nav('Library');`);
    else if (state === 'playing-library') {
      await evaluate(`await nav('Library');
        const input = document.querySelector('[data-newamp-library-search-command] input');
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(input, 'Bench Fixture'); input.dispatchEvent(new Event('input', { bubbles: true }));
        const row = await waitFor('fixture', () => [...document.querySelectorAll('[data-newamp-track-row]')].find((r) => /Bench Fixture 1/.test(r.textContent || '')));
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        await waitFor('playing', () => document.querySelector('[data-newamp-transport][data-newamp-playing="true"]'));
        set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true }));`);
    } else if (state === 'playing-home') await evaluate(`await nav('Home');`);
    else if (state === 'playing-artists') await evaluate(`await nav('Artists');`);
    else if (state === 'playing-nowplaying') await evaluate(`await nav('Now Playing');`);
    else throw new Error(`unknown state ${state}`);
    await sleep(3000);
    results.push(await measure(state));
  }
  console.log(`${TRACKS.toLocaleString('en-US')} tracks / ${ARTISTS.toLocaleString('en-US')} artists, ${process.platform}${disableGpu ? ', --disable-gpu' : ''}, % of one core`);
  console.table(results);
  stop();
} catch (err) {
  stop(err);
}

function stop(err) {
  clearTimeout(watchdog);
  child.kill();
  if (err) {
    console.error(err, `\n${stderr.split(/\r?\n/).slice(-15).join('\n')}`);
    process.exit(1);
  }
  process.exit(0);
}

async function connect() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, bad) => { socket.onopen = ok; socket.onerror = bad; });
        socket.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        };
        return socket;
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('no DevTools page');
}

async function evaluate(body) {
  const id = ++seq;
  const expression = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (label, fn, timeout = 15000) => { const s = performance.now(); while (performance.now() - s < timeout) { const v = fn(); if (v) return v; await sleep(60); } throw new Error('timed out waiting for ' + label); };
    const nav = async (label) => { (await waitFor(label, () => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label))).click(); await sleep(400); };
    ${body}
    return true; })()`;
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const res = await new Promise((r) => pending.set(id, r));
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'page error');
}

// --- synthetic library -------------------------------------------------------
async function buildLibrary() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(userData, { recursive: true });
  mkdirSync(media, { recursive: true });
  for (let i = 1; i <= 3; i += 1) {
    const file = join(media, `0${i} - Bench Fixture ${i}.mp3`);
    const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${220 * i}:duration=240`,
      '-metadata', `title=Bench Fixture ${i}`, '-metadata', 'artist=Bench', '-metadata', 'album=Bench', '-c:a', 'libmp3lame', '-q:a', '6', file],
    { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr}`);
  }
  const { LibraryStore } = await import(pathToFileURL(resolve('dist-electron', 'electron', 'library.js')).href);
  const lib = await LibraryStore.open(join(userData, 'library.db'));
  const syllables = ['ka', 'lo', 'mi', 'ra', 'ven', 'dor', 'ash', 'tri', 'bel', 'zu', 'on', 'qui', 'sel', 'mar', 'the', 'nox'];
  // Initials spread across the alphabet like a real collection.
  const artistName = (a) => `${String.fromCharCode(65 + ((a * 7) % 26))}${syllables[a % 16]}${syllables[(a >> 4) % 16]} ${a}`;
  const perArtist = Math.max(1, Math.ceil(TRACKS / ARTISTS));
  for (let offset = 0; offset < TRACKS; offset += 3000) {
    const batch = [];
    for (let n = offset; n < Math.min(TRACKS, offset + 3000); n += 1) {
      const a = Math.floor(n / perArtist);
      batch.push({
        path: join(root, 'synthetic', `a${a}`, `al${Math.floor(n / 10)}`, `t${n}.flac`),
        title: `Song ${n}`, artist: artistName(a), album: `Album ${Math.floor(n / 10)}`, albumArtist: artistName(a),
        trackNo: (n % 10) + 1, discNo: null, year: 1970 + (n % 55), genre: ['Rock', 'Electronic', 'Jazz', 'Folk'][n % 4],
        duration: 150 + (n % 240), bitrate: 320000, sampleRate: 44100, bpm: 70 + (n % 110), key: null,
        replayGainTrackDb: null, replayGainAlbumDb: null, size: 5_000_000 + n, mtime: 1_700_000_000_000 + n, art: null,
      });
    }
    lib.upsertTracks(batch);
  }
  await lib.close();
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ libraryRoots: [media], volume: 0, lastfmEnabled: false }), 'utf8');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function round(value) {
  return Math.round(value * 10) / 10;
}
