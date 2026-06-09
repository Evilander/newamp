// Preflight: verify the packaged macOS .app is Developer-ID-signed and accepted
// by Gatekeeper BEFORE we submit it to Apple's notary service. Apple rejects
// ad-hoc/unsigned hardened-runtime apps, so submitting one wastes a round-trip
// and (in CI) fails confusingly. Exits 0 with a notice when there's nothing to
// check (non-darwin, or no packaged .app yet) to match the env-gated style of
// the other release scripts. Usage: node scripts/verify-mac-signing.mjs [appPath]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.platform !== 'darwin') {
  console.log('[verify-mac-signing] not darwin — skipping');
  process.exit(0);
}

const candidates = [
  process.argv[2],
  resolve('release/mac-arm64/NewAmp.app'),
  resolve('release/mac/NewAmp.app'),
  resolve('release/mac-x64/NewAmp.app'),
].filter(Boolean);
const appPath = candidates.find((p) => existsSync(p));
if (!appPath) {
  console.log('[verify-mac-signing] no packaged .app found — skipping (run package:mac first)');
  process.exit(0);
}

const codesign = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { encoding: 'utf8' });
const spctl = spawnSync('spctl', ['-a', '-vvv', '-t', 'install', appPath], { encoding: 'utf8' });

const codesignOk = codesign.status === 0;
const spctlOut = `${spctl.stdout || ''}${spctl.stderr || ''}`;
const devIdOk = spctl.status === 0 && /Developer ID Application/.test(spctlOut);

console.log(`[verify-mac-signing] app: ${appPath}`);
console.log(`[verify-mac-signing] codesign --verify: ${codesignOk ? 'OK' : 'FAIL'}`);
console.log(`[verify-mac-signing] spctl assess: ${devIdOk ? 'Developer ID OK' : 'NOT Developer-ID-accepted'}`);

if (!codesignOk || !devIdOk) {
  console.error(
    '[verify-mac-signing] App is not Developer-ID-signed/accepted. ' +
    'Set CSC_LINK/CSC_KEY_PASSWORD for package:mac (see docs/macos-signing.md). ' +
    'Refusing to notarize an unsignable artifact.',
  );
  console.error(codesign.stderr || '');
  console.error(spctlOut);
  process.exit(1);
}
console.log('[verify-mac-signing] OK — Developer ID signed.');
