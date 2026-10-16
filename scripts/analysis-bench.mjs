// What the library-wide analysis costs per track, on files you name. Reads the
// files and writes only into tmp/ (a throwaway waveform cache).
// Run: npm run build:electron && node scripts/analysis-bench.mjs <audio file>...
import { cpus } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/analysis-bench.mjs <audio file>...');
  process.exit(2);
}

const cache = resolve('tmp', 'analysis-bench-cache');
await rm(cache, { recursive: true, force: true });
await mkdir(cache, { recursive: true });
const { initWaveformCache } = await import(pathToFileURL(resolve('dist-electron/electron/waveform-peaks.js')).href);
const { analyzeTrack } = await import(pathToFileURL(resolve('dist-electron/electron/track-analyzer.js')).href);
initWaveformCache(cache);

function machineCpu() {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

const rows = [];
for (const file of files) {
  const machine = machineCpu();
  const cpu = process.cpuUsage();
  const started = performance.now();
  let row;
  try {
    const result = await analyzeTrack({
      path: file,
      want: { loud: true, tempo: true, dna: true, peaks: true },
    });
    row = {
      file: file.split(/[\\/]/).pop(),
      audioSeconds: Math.round(result.seconds),
      lufs: result.loudness?.integratedLufs ?? null,
      bpm: result.tempo?.bpm ?? null,
      key: result.tempo?.key ?? null,
      dna: result.dna ? result.dna.rms : null,
      peaks: result.peaksStored,
    };
  } catch (err) {
    row = { file: file.split(/[\\/]/).pop(), error: String(err).split('\n')[0] };
  }
  const wallMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const after = machineCpu();
  rows.push({
    ...row,
    wallMs: Math.round(wallMs),
    nodeCpuMs: Math.round((used.user + used.system) / 1000),
    machineBusy: Number((1 - (after.idle - machine.idle) / (after.total - machine.total)).toFixed(3)),
  });
}
console.table(rows);
const ok = rows.filter((r) => !r.error);
if (ok.length) {
  const wall = ok.reduce((sum, r) => sum + r.wallMs, 0);
  console.log(`${ok.length} tracks, ${(wall / ok.length / 1000).toFixed(2)} s each on average (${(wall / 1000).toFixed(1)} s total)`);
}
await rm(cache, { recursive: true, force: true });
