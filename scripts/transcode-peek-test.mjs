// Unit test for peekCachedFlac (non-blocking cache probe) — builds electron to
// dist-electron, points the cache at a temp dir, generates a tiny wma fixture
// with ffmpeg-static (same approach as transcode-smoke), and asserts the probe
// never transcodes, returns the path only once finalized, and ignores .part files.
// Run: npm run build:electron && node scripts/transcode-peek-test.mjs
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync(resolve(repoRoot, 'tmp'), { recursive: true });
const RESULT = resolve(repoRoot, 'tmp/transcode-peek-test-result.txt');
writeFileSync(RESULT, '[transcode-peek-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

const { initTranscodeCache, getOrTranscodeToFlac, peekCachedFlac } = await import(
  new URL('../dist-electron/electron/transcode-cache.js', import.meta.url).href
);

const root = join(repoRoot, 'tmp', 'transcode-peek-test');
await rm(root, { recursive: true, force: true });
await mkdir(join(root, 'cache'), { recursive: true });
await mkdir(join(root, 'music'), { recursive: true });

const src = join(root, 'music', 'probe.wma');
const gen = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'wmav2', src], { encoding: 'utf8' });
if (gen.status !== 0) { writeFileSync(RESULT, 'fixture generation failed\n' + gen.stderr); console.error('fixture failed'); process.exit(1); }

initTranscodeCache(join(root, 'cache'));

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };

// 1) Probe before any transcode → null, and creates NOTHING in the cache dir.
const before = await peekCachedFlac(src);
if (before !== null) fail(`peek before transcode should be null, got ${before}`);
if (readdirSync(join(root, 'cache')).length !== 0) fail('peek must not create cache files');
log.push('peek-before: null, no side effects');

// 2) Full transcode, then probe → the finalized path.
const full = await getOrTranscodeToFlac(src);
if (!full.ok) fail(`getOrTranscodeToFlac failed: ${full.reason}`);
const after = await peekCachedFlac(src);
if (!after || after !== full.path) fail(`peek after transcode should equal ${full.path}, got ${after}`);
if (!existsSync(after)) fail('peeked path does not exist');
log.push('peek-after: returns finalized path');

// 3) A lone .part must NOT satisfy the probe.
unlinkSync(full.path);
writeFileSync(full.path + '.123.flac.part', 'partial');
const partOnly = await peekCachedFlac(src);
if (partOnly !== null) fail(`peek with only a .part present should be null, got ${partOnly}`);
log.push('peek-part-only: null');

const report = log.join('\n') + '\n' + (pass ? '[transcode-peek-test] PASS' : '[transcode-peek-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
