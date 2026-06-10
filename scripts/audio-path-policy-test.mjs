// Unit test for isAllowedAudioPath (esbuild harness).
// Run: node scripts/audio-path-policy-test.mjs
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync(resolve('tmp'), { recursive: true });
const RESULT = resolve('tmp/audio-path-policy-test-result.txt');
writeFileSync(RESULT, '[audio-path-policy-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

await build({
  entryPoints: [resolve('electron/audio-path-policy.ts')],
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  outfile: resolve('tmp/audio-path-policy-bundle.mjs'), logLevel: 'silent',
});
const { isAllowedAudioPath } = await import(pathToFileURL(resolve('tmp/audio-path-policy-bundle.mjs')).href);

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const eq = (got, want, msg) => { log.push(`${msg}: ${got}`); if (got !== want) fail(`${msg} — expected ${want}, got ${got}`); };

const base = {
  libraryRoots: [],
  openedFiles: new Set(),
  podcastRoot: null,
  isLibraryTrack: false,
  platform: 'linux',
};

// 1. Library-root containment.
eq(isAllowedAudioPath({ ...base, realPath: '/music/album/song.mp3', libraryRoots: ['/music'] }),
  true, 'file under a configured root → allowed');
eq(isAllowedAudioPath({ ...base, realPath: '/music-evil/song.mp3', libraryRoots: ['/music'] }),
  false, 'sibling sharing the root as a string prefix (/music-evil) → denied');
eq(isAllowedAudioPath({ ...base, realPath: '/music', libraryRoots: ['/music'] }),
  true, 'path exactly equal to a root entry (root may be a file) → allowed');

// 2. Library DB membership.
eq(isAllowedAudioPath({ ...base, realPath: '/elsewhere/imported.flac', isLibraryTrack: true }),
  true, 'library DB track outside any root → allowed');

// 3. Session opened files.
eq(isAllowedAudioPath({ ...base, realPath: '/downloads/dropped.wav', openedFiles: new Set(['/downloads/dropped.wav']) }),
  true, 'session-opened file → allowed');
eq(isAllowedAudioPath({ ...base, realPath: '/downloads/other.wav', openedFiles: new Set(['/downloads/dropped.wav']) }),
  false, 'sibling of a session-opened file → denied');

// 4. Podcast downloads root.
eq(isAllowedAudioPath({ ...base, realPath: '/userdata/podcast-downloads/show/ep1.mp3', podcastRoot: '/userdata/podcast-downloads' }),
  true, 'file under the podcast downloads root → allowed');

// 5. Everything else fails.
eq(isAllowedAudioPath({ ...base, realPath: '/etc/passwd', libraryRoots: ['/music'], podcastRoot: '/userdata/podcast-downloads', openedFiles: new Set(['/downloads/dropped.wav']) }),
  false, 'path outside every signal → denied');

// 6. Case folding: win32/darwin filesystems are case-insensitive, linux is not.
eq(isAllowedAudioPath({ ...base, realPath: '/Music/Song.flac', libraryRoots: ['/music'], platform: 'darwin' }),
  true, 'darwin folds case for root containment');
eq(isAllowedAudioPath({ ...base, realPath: '/Music/Song.flac', libraryRoots: ['/music'], platform: 'win32' }),
  true, 'win32 folds case for root containment');
eq(isAllowedAudioPath({ ...base, realPath: '/Music/Song.flac', libraryRoots: ['/music'], platform: 'linux' }),
  false, 'linux keeps case-sensitive root containment');
eq(isAllowedAudioPath({ ...base, realPath: '/Downloads/Dropped.wav', openedFiles: new Set(['/downloads/dropped.wav']), platform: 'darwin' }),
  true, 'darwin folds case for opened-files membership');

// 7. Windows separators normalize before compare.
eq(isAllowedAudioPath({ ...base, realPath: 'K:\\Music\\album\\song.mp3', libraryRoots: ['K:/music'], platform: 'win32' }),
  true, 'backslash realpath matches forward-slash root on win32');
eq(isAllowedAudioPath({ ...base, realPath: 'K:\\Music-Evil\\song.mp3', libraryRoots: ['K:/music'], platform: 'win32' }),
  false, 'backslash sibling prefix still denied on win32');

// 8. Empty configuration is safe (deny, no crash).
eq(isAllowedAudioPath({ ...base, realPath: '/music/song.mp3' }),
  false, 'empty roots + empty opened set + null podcast root → denied without crashing');

const report = log.join('\n') + '\n' + (pass ? '[audio-path-policy-test] PASS' : '[audio-path-policy-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
