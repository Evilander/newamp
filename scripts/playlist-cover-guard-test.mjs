// Unit tests for the playlist cover-path approval guard (electron/playlist-cover-guard.ts).
// playlist:save must refuse any coverImagePath that wasn't just returned by
// playlist:pick-cover's dialog.showOpenDialog() result — otherwise a
// compromised renderer could point main at an arbitrary local file, which
// gets copied into the playlist-art cache and served back over
// newplaylistart://. Run: npm run build:electron && node scripts/playlist-cover-guard-test.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlaylistCoverGuard } from '../dist-electron/electron/playlist-cover-guard.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync(resolve(repoRoot, 'tmp'), { recursive: true });
const RESULT = resolve(repoRoot, 'tmp/playlist-cover-guard-test-result.txt');
writeFileSync(RESULT, '[playlist-cover-guard-test] starting…\n');
process.on('uncaughtException', (e) => { writeFileSync(RESULT, 'UNCAUGHT: ' + (e?.stack || e) + '\n'); process.exitCode = 1; });

const log = [];
let pass = true;
const fail = (m) => { pass = false; log.push('FAIL: ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pickedPath = join(repoRoot, 'tmp', 'a-real-picked-cover.png');
const attackerPath = join(repoRoot, 'tmp', 'secrets', 'not-picked.png');

// 1. A path that was never approved (e.g. a renderer calling savePlaylist
//    directly, bypassing the picker dialog) must be rejected.
{
  const guard = createPlaylistCoverGuard();
  if (guard.isApproved(attackerPath)) fail('an unapproved path must not be approved');
  log.push('unapproved path rejected: ok');
}

// 2. A path playlist:pick-cover just returned (approve()) is accepted.
{
  const guard = createPlaylistCoverGuard();
  guard.approve(pickedPath);
  if (!guard.isApproved(pickedPath)) fail('a freshly approved path must be accepted');
  log.push('approved path accepted: ok');
}

// 3. Approving one path must not approve an unrelated path.
{
  const guard = createPlaylistCoverGuard();
  guard.approve(pickedPath);
  if (guard.isApproved(attackerPath)) fail('approving one path must not approve a different path');
  log.push('approval does not leak to other paths: ok');
}

// 4. Path resolution: an equivalent path form (relative segments that
//    resolve to the same absolute path) must still match, since the guard
//    normalizes with node:path resolve() before comparing.
{
  const guard = createPlaylistCoverGuard();
  guard.approve(pickedPath);
  const equivalent = join(repoRoot, 'tmp', 'nested', '..', 'a-real-picked-cover.png');
  if (!guard.isApproved(equivalent)) fail('an equivalent (resolve()-identical) path must be accepted');
  log.push('resolve()-equivalent path accepted: ok');
}

// 5. Approval expires after the configured TTL.
{
  const guard = createPlaylistCoverGuard(30);
  guard.approve(pickedPath);
  if (!guard.isApproved(pickedPath)) fail('path should be approved immediately after approve()');
  await sleep(80);
  if (guard.isApproved(pickedPath)) fail('approval must expire after ttlMs elapses');
  log.push('TTL expiry enforced: ok');
}

const report = log.join('\n') + '\n' + (pass ? '[playlist-cover-guard-test] PASS' : '[playlist-cover-guard-test] FAIL') + '\n';
writeFileSync(RESULT, report);
console.log(report);
process.exitCode = pass ? 0 : 1;
